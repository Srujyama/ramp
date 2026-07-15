/**
 * @ramp/dashboard — activity.test.ts
 *
 * recentDecisions is the selection behind the Overview "Recent Activity" strip.
 * These tests pin its contract: at most `n` items, newest-first, stable for
 * equal timestamps, non-mutating, and defensive against missing / malformed
 * `ts` (those sort to the end and never throw). Run on compiled JS via
 * `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentDecisions, lastUpdatedLabel } from "./activity.js";
import { mkView } from "./testfixtures.js";
import type { DecisionView } from "./types.js";

function at(id: string, ts: string): DecisionView {
  return mkView({ decisionId: id, ts });
}

test("empty input yields an empty array", () => {
  assert.deepEqual(recentDecisions([]), []);
});

test("returns at most n items", () => {
  const views = Array.from({ length: 10 }, (_, i) =>
    at(`d${i}`, `2026-07-14 10:00:${String(i).padStart(2, "0")}`),
  );
  assert.equal(recentDecisions(views, 5).length, 5);
  assert.equal(recentDecisions(views, 3).length, 3);
  // Fewer rows than n → all of them.
  assert.equal(recentDecisions(views.slice(0, 2), 5).length, 2);
});

test("n <= 0 yields an empty array", () => {
  const views = [at("a", "2026-07-14 10:00:00")];
  assert.deepEqual(recentDecisions(views, 0), []);
  assert.deepEqual(recentDecisions(views, -3), []);
});

test("orders newest first regardless of input order", () => {
  const views = [
    at("old", "2026-07-14 09:00:00"),
    at("new", "2026-07-14 11:00:00"),
    at("mid", "2026-07-14 10:00:00"),
  ];
  const ids = recentDecisions(views, 5).map((v) => v.decisionId);
  assert.deepEqual(ids, ["new", "mid", "old"]);
});

test("is stable for equal timestamps (keeps input order)", () => {
  const ts = "2026-07-14 10:00:00";
  const views = [at("first", ts), at("second", ts), at("third", ts)];
  const ids = recentDecisions(views, 5).map((v) => v.decisionId);
  assert.deepEqual(ids, ["first", "second", "third"]);
});

test("malformed / missing ts does not throw and sorts to the end", () => {
  const views = [
    at("garbage", "not-a-date"),
    at("good-late", "2026-07-14 12:00:00"),
    mkView({ decisionId: "no-ts", ts: undefined as unknown as string }),
    at("good-early", "2026-07-14 08:00:00"),
  ];
  let ids: string[] = [];
  assert.doesNotThrow(() => {
    ids = recentDecisions(views, 5).map((v) => v.decisionId);
  });
  // The two parseable rows come first (newest-first); the unparseable ones
  // trail, preserving their relative input order (stability).
  assert.deepEqual(ids, ["good-late", "good-early", "garbage", "no-ts"]);
});

test("does not mutate the input array or its order", () => {
  const views = [
    at("old", "2026-07-14 09:00:00"),
    at("new", "2026-07-14 11:00:00"),
  ];
  const snapshot = views.map((v) => v.decisionId);
  recentDecisions(views, 5);
  assert.deepEqual(
    views.map((v) => v.decisionId),
    snapshot,
  );
});

test("non-array input is handled defensively", () => {
  assert.deepEqual(
    recentDecisions(undefined as unknown as DecisionView[]),
    [],
  );
});

test("lastUpdatedLabel reports honest elapsed time", () => {
  const now = new Date("2026-07-14T10:00:30Z");
  assert.equal(lastUpdatedLabel(new Date("2026-07-14T10:00:25Z"), now), "Updated 5s ago");
  assert.equal(lastUpdatedLabel(new Date("2026-07-14T09:58:30Z"), now), "Updated 2m ago");
  // Future clock skew never reads as negative.
  assert.equal(lastUpdatedLabel(new Date("2026-07-14T10:01:00Z"), now), "Updated 0s ago");
});

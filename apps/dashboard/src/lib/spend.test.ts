import { test } from "node:test";
import assert from "node:assert/strict";
import { isSettledSpend, dateKey, todayKey, settledSpendOn, settledSpendTotal } from "./spend.js";
import { mkView } from "./testfixtures.js";

const settled = { receiptId: "r1", executionId: "e1", status: "settled" as const, provider: "sandbox", executedAt: "2026-07-15 10:00:00" };
const failed = { ...settled, status: "failed" as const };

// --- the predicate: exactly one definition of "money moved" -----------------

test("isSettledSpend: only allow + settled execution is spend", () => {
  assert.equal(isSettledSpend(mkView({ outcome: "allow", execution: settled })), true);

  // (a) denied
  assert.equal(isSettledSpend(mkView({ outcome: "deny", status: "denied", execution: null })), false);
  // (b) allowed but never executed
  assert.equal(isSettledSpend(mkView({ outcome: "allow", execution: null })), false);
  // (c) allowed but execution failed
  assert.equal(isSettledSpend(mkView({ outcome: "allow", execution: failed })), false);
  // held for a human
  assert.equal(isSettledSpend(mkView({ outcome: "escalate", status: "escalated", execution: null })), false);
  // no outcome recorded at all
  assert.equal(isSettledSpend(mkView({ outcome: null, status: "error", execution: null })), false);
});

test("isSettledSpend: a denied decision with a settled receipt is still not spend", () => {
  // Defensive: outcome and execution are separate columns. A deny must never
  // count even if an execution row somehow exists against it.
  assert.equal(isSettledSpend(mkView({ outcome: "deny", status: "denied", execution: settled })), false);
});

// --- date bucketing ---------------------------------------------------------

test("dateKey converts SQLite UTC datetimes to a calendar day", () => {
  assert.equal(dateKey("2026-07-15 09:00:00"), "2026-07-15");
  assert.equal(dateKey("2026-07-15 23:59:59"), "2026-07-15");
});

test("dateKey never throws on a malformed timestamp", () => {
  assert.equal(dateKey("not-a-date"), "not-a-dat");
  assert.equal(dateKey(""), "unknown");
});

test("todayKey uses the UTC day, matching SQLite date('now')", () => {
  // 23:30 UTC on the 15th is still the 15th — and would be the 16th in some
  // local zones, which is exactly the drift this avoids.
  assert.equal(todayKey(new Date("2026-07-15T23:30:00Z")), "2026-07-15");
  assert.equal(todayKey(new Date("2026-07-16T00:10:00Z")), "2026-07-16");
});

// --- the aggregates ---------------------------------------------------------

test("settledSpendOn sums only today's settled money", () => {
  const rows = [
    mkView({ decisionId: "a", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 340, execution: settled }),
    mkView({ decisionId: "b", ts: "2026-07-15 10:00:00", outcome: "allow", amount: 319, execution: settled }),
    mkView({ decisionId: "c", ts: "2026-07-15 11:00:00", outcome: "allow", amount: 500, execution: null }), // not executed
    mkView({ decisionId: "d", ts: "2026-07-15 12:00:00", outcome: "deny", status: "denied", amount: 900, execution: null }),
    mkView({ decisionId: "e", ts: "2026-07-14 09:00:00", outcome: "allow", amount: 1000, execution: settled }), // yesterday
  ];
  assert.equal(settledSpendOn(rows, "2026-07-15"), 659);
  assert.equal(settledSpendOn(rows, "2026-07-14"), 1000);
  assert.equal(settledSpendOn(rows, "2026-07-13"), 0);
});

test("settledSpendOn returns 0 for an empty feed — an honest zero, not a guess", () => {
  assert.equal(settledSpendOn([], "2026-07-15"), 0);
});

test("settledSpendTotal sums settled money across every day in the window", () => {
  const rows = [
    mkView({ decisionId: "a", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 340, execution: settled }),
    mkView({ decisionId: "b", ts: "2026-07-14 09:00:00", outcome: "allow", amount: 1000, execution: settled }),
    mkView({ decisionId: "c", ts: "2026-07-14 10:00:00", outcome: "allow", amount: 700, execution: failed }),
  ];
  assert.equal(settledSpendTotal(rows), 1340);
});

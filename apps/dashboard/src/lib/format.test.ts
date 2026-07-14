/**
 * @ramp/dashboard — format.test.ts
 *
 * The honest status-derivation logic: chips reflect only what the audit trail
 * records, so a gate-only allow never reads as "settled" and a tampered proof
 * never reads as "verified". Run on compiled JS via `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMoney,
  formatTimestamp,
  formatRelative,
  ruleTitle,
  ruleBlurb,
  outcomeChip,
  verificationChip,
  paymentChip,
} from "./format.js";
import { mkView } from "./testfixtures.js";

test("formatMoney renders whole units without cents", () => {
  assert.match(formatMoney(340, "USD"), /340/);
  assert.doesNotMatch(formatMoney(340, "USD"), /\.00/);
  // Unknown currency falls back gracefully instead of throwing.
  assert.match(formatMoney(50, "ZZZ"), /50/);
});

test("formatTimestamp parses the SQLite UTC datetime", () => {
  const out = formatTimestamp("2026-07-14 10:00:00");
  assert.match(out, /2026/);
  assert.notEqual(out, "2026-07-14 10:00:00"); // reformatted, not echoed
});

test("formatRelative produces coarse buckets", () => {
  const now = new Date("2026-07-14T10:05:00Z");
  assert.equal(formatRelative("2026-07-14 10:05:00", now), "just now");
  assert.equal(formatRelative("2026-07-14 10:03:00", now), "2m ago");
  assert.equal(formatRelative("2026-07-14 08:05:00", now), "2h ago");
});

test("rule labels humanize the raw ids", () => {
  assert.equal(ruleTitle("allow/all_conditions_met"), "All conditions met");
  assert.match(ruleBlurb("deny/vendor_not_verified"), /registry/);
});

test("outcomeChip maps allow/deny/error honestly", () => {
  assert.deepEqual(
    [outcomeChip(mkView({ outcome: "allow" })).label, outcomeChip(mkView({ outcome: "allow" })).tone],
    ["Allowed", "accent"],
  );
  assert.equal(outcomeChip(mkView({ outcome: "deny", status: "denied" })).label, "Denied");
  assert.equal(outcomeChip(mkView({ status: "error", outcome: null })).tone, "warn");
});

test("verificationChip covers all four proof states", () => {
  assert.equal(verificationChip("ok").label, "Verified");
  assert.equal(verificationChip("ok").tone, "accent");
  assert.equal(verificationChip("mismatch").label, "Tampered");
  assert.equal(verificationChip("mismatch").tone, "deny");
  assert.equal(verificationChip("corrupt").label, "Corrupt");
  assert.equal(verificationChip("absent").label, "No proof");
  assert.equal(verificationChip("absent").tone, "neutral");
});

test("paymentChip never claims a settlement it can't prove", () => {
  const settled = paymentChip(
    mkView({ execution: { receiptId: "rcpt_1", executionId: "exec_1", status: "settled", provider: "sandbox", executedAt: "2026-07-14 10:00:00" } }),
  );
  assert.equal(settled.label, "Settled");
  assert.equal(settled.tone, "accent");

  const failed = paymentChip(
    mkView({ execution: { receiptId: "rcpt_2", executionId: "exec_2", status: "failed", provider: "sandbox", executedAt: "2026-07-14 10:00:00" } }),
  );
  assert.equal(failed.label, "Payment failed");
  assert.equal(failed.tone, "deny");

  // Deny → blocked, executor never called.
  assert.equal(paymentChip(mkView({ outcome: "deny", status: "denied", execution: null })).label, "Blocked");
  // Allow but no recorded execution (gate-only hook row) → not executed, never "settled".
  assert.equal(paymentChip(mkView({ outcome: "allow", execution: null })).label, "Not executed");
});

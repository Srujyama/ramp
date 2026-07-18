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
  explainDecision,
  explainSimulation,
} from "./format.js";
import { mkView } from "./testfixtures.js";
import type { RuleId } from "./types.js";

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

test("outcomeChip never renders escalate as a deny", () => {
  const chip = outcomeChip(mkView({ outcome: "escalate", status: "escalated" }));
  assert.equal(chip.label, "Needs approval");
  assert.notEqual(chip.tone, "deny");
});

test("verificationChip covers all four proof states", () => {
  assert.equal(verificationChip("ok").label, "Proof valid");
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
  assert.equal(settled.label, "Settled (sandbox)");
  assert.equal(settled.tone, "accent");

  const failed = paymentChip(
    mkView({ execution: { receiptId: "rcpt_2", executionId: "exec_2", status: "failed", provider: "sandbox", executedAt: "2026-07-14 10:00:00" } }),
  );
  assert.equal(failed.label, "Payment failed");
  assert.equal(failed.tone, "deny");

  // Deny → blocked, executor never called.
  assert.equal(paymentChip(mkView({ outcome: "deny", status: "denied", execution: null })).label, "Blocked");
  // Allow but no recorded execution (gate-only policy row) → not executed, never "settled".
  assert.equal(paymentChip(mkView({ outcome: "allow", execution: null })).label, "Not executed");
  // Escalate → held for a human, never conflated with a deny's "Blocked".
  const held = paymentChip(mkView({ outcome: "escalate", status: "escalated", execution: null }));
  assert.equal(held.label, "Held");
  assert.notEqual(held.label, "Blocked");
});

test("explainDecision narrates an allow that settled", () => {
  const out = explainDecision(
    mkView({
      outcome: "allow",
      execution: { receiptId: "rcpt_1", executionId: "exec_1", status: "settled", provider: "sandbox", executedAt: "2026-07-14 10:00:00" },
    }),
  );
  assert.match(out, /^Allowed because the vendor is verified/);
  assert.match(out, /The sandbox payment settled\.$/);
});

test("explainDecision narrates an allow whose executor failed", () => {
  const out = explainDecision(
    mkView({
      outcome: "allow",
      execution: { receiptId: "rcpt_2", executionId: "exec_2", status: "failed", provider: "sandbox", executedAt: "2026-07-14 10:00:00" },
    }),
  );
  assert.equal(out, "Policy allowed the purchase, but the payment executor failed. No settlement occurred.");
});

test("explainDecision narrates an allow that was never executed", () => {
  const out = explainDecision(mkView({ outcome: "allow", execution: null }));
  assert.equal(out, "Allowed by policy. Every condition held. No sandbox payment was executed for this record.");
});

test("explainDecision narrates a deny with its fired reasons joined", () => {
  const out = explainDecision(
    mkView({
      outcome: "deny",
      status: "denied",
      execution: null,
      firedRules: ["deny/vendor_not_verified", "deny/over_per_txn_cap"],
    }),
  );
  assert.equal(
    out,
    "Denied because the vendor is not in the approved registry and the amount exceeds the per-transaction cap. No payment was executed.",
  );
});

test("explainDecision surfaces a proof mismatch above the outcome", () => {
  // Even an allow reads as compromised when the proof no longer matches.
  const out = explainDecision(
    mkView({
      outcome: "allow",
      proofVerification: { proofPresent: true, proofVerified: false, expectedProofId: "proof_x", actualProofId: "proof_y", reason: "mismatch" },
    }),
  );
  assert.equal(out, "The stored proof no longer matches the recorded decision. No payment was executed.");
});

test("explainDecision surfaces a corrupt proof above the outcome", () => {
  const out = explainDecision(
    mkView({
      outcome: "allow",
      proofVerification: { proofPresent: true, proofVerified: false, expectedProofId: null, actualProofId: null, reason: "corrupt" },
    }),
  );
  assert.equal(out, "The stored proof is malformed and could not be verified. Treat this record as compromised.");
});

test("explainDecision narrates an escalation as held, not denied", () => {
  const out = explainDecision(
    mkView({
      outcome: "escalate",
      status: "escalated",
      execution: null,
      firedRules: ["escalate/over_escalation_threshold"],
    }),
  );
  assert.match(out, /^Held for human approval because/);
  assert.doesNotMatch(out, /^Denied/);
});

test("explainDecision narrates a pre-decision error", () => {
  const out = explainDecision(
    mkView({
      status: "error",
      outcome: null,
      firedRules: [],
      proofVerification: { proofPresent: false, proofVerified: false, expectedProofId: null, actualProofId: null, reason: "absent" },
    }),
  );
  assert.equal(out, "An error occurred before a policy decision was reached. No payment was executed.");
});

test("explainSimulation narrates an allow", () => {
  const out = explainSimulation("allow", ["allow/all_conditions_met"]);
  assert.match(out, /^Allowed\. Every policy condition held/);
  assert.match(out, /within the per-transaction cap and daily limit\.$/);
});

test("explainSimulation narrates a deny with joined reasons", () => {
  const out = explainSimulation("deny", ["deny/category_not_approved", "deny/daily_limit_exceeded"]);
  assert.equal(
    out,
    "Denied because the category is not on the approved list and it would exceed the daily limit. No payment would be executed.",
  );
});

test("explainSimulation narrates an escalation as held, not denied", () => {
  const out = explainSimulation("escalate", ["escalate/elevated_risk_vendor"]);
  assert.match(out, /^Would be held for human approval because/);
  assert.doesNotMatch(out, /^Denied/);
});

test("explainSimulation produces a distinct phrase for every deny rule id", () => {
  const denyRules: RuleId[] = [
    "deny/vendor_not_verified",
    "deny/over_per_txn_cap",
    "deny/agent_uncleared_for_category",
    "deny/category_not_approved",
    "deny/daily_limit_exceeded",
  ];
  const phrases = denyRules.map((r) => {
    const out = explainSimulation("deny", [r]);
    const m = out.match(/^Denied because (.*)\. No payment would be executed\.$/);
    assert.ok(m, `unexpected shape for ${r}: ${out}`);
    return m[1] as string;
  });
  // Every rule yields a non-empty, generic-fallback-free phrase.
  for (const p of phrases) {
    assert.ok(p.length > 0);
    assert.notEqual(p, "the policy conditions were not met");
  }
  // And every phrase is unique — no two deny rules collapse to the same wording.
  assert.equal(new Set(phrases).size, denyRules.length);
});

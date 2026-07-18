/**
 * @ramp/dashboard — timeline.test.ts
 *
 * The six-stage execution lifecycle. Asserts the per-stage state for EVERY path,
 * proving the states stay separable: policy denial (blocked) vs payment failure
 * (failed) vs proof mismatch (failed) vs corrupt proof (corrupt) vs a gate-only
 * allow that never executed (skipped) vs an infrastructure error row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type StageState, type TimelineStage } from "./timeline.js";
import type { DecisionView, ExecutionRecord, LedgerProof } from "./types.js";
import { mkView } from "./testfixtures.js";

const settledExec: ExecutionRecord = {
  settlementId: "rcpt_1",
  executionId: "exec_1",
  status: "settled",
  provider: "sandbox",
  executedAt: "2026-07-14 10:00:00",
};
const failedExec: ExecutionRecord = { ...settledExec, status: "failed" };

const proof: LedgerProof = {
  schema: "proof/v1",
  proofId: "proof_x",
  decisionId: "dec_test",
  decision: { decision: "allow", reasons: [], firedRules: ["allow/all_conditions_met"] },
  requestDigest: "rd",
  factsDigest: "fd",
  policyDigest: "policy_abc",
  kernelId: "ts-reference",
  kernelVersion: "1",
  attestationStatus: "absent",
  attestationProvider: null,
  provenance: null,
  producedAt: 0,
  latencyMs: null,
};

type StageKey = "request" | "facts" | "policy" | "decision" | "proof" | "payment";
function byKey(stages: TimelineStage[]): Record<StageKey, TimelineStage> {
  return Object.fromEntries(stages.map((s) => [s.key, s])) as Record<StageKey, TimelineStage>;
}
function states(v: DecisionView): Record<StageKey, StageState> {
  return Object.fromEntries(buildTimeline(v).map((s) => [s.key, s.state])) as Record<
    StageKey,
    StageState
  >;
}

test("six stages, fixed order", () => {
  assert.deepEqual(
    buildTimeline(mkView()).map((s) => s.key),
    ["request", "facts", "policy", "decision", "proof", "payment"],
  );
});

test("path: allow + settled — everything done", () => {
  const s = states(mkView({ facts: mkFacts(), proof, execution: settledExec }));
  assert.deepEqual(s, {
    request: "done",
    facts: "done",
    policy: "done",
    decision: "done",
    proof: "done",
    payment: "done",
  });
  const stages = byKey(buildTimeline(mkView({ execution: settledExec })));
  assert.equal(stages.payment.title, "Payment executed");
  assert.match(stages.payment.detail, /no real money moves/);
});

test("path: deny + blocked — payment blocked, not failed", () => {
  const v = mkView({
    status: "denied",
    outcome: "deny",
    firedRules: ["deny/vendor_not_verified"],
    decision: { decision: "deny", reasons: ["vendor unverified"], firedRules: ["deny/vendor_not_verified"] },
    execution: null,
  });
  const stages = byKey(buildTimeline(v));
  assert.equal(stages.payment.state, "blocked");
  assert.equal(stages.payment.title, "Payment blocked");
  assert.match(stages.payment.detail, /executor never called/);
  assert.equal(stages.policy.state, "done");
  assert.match(stages.policy.detail, /Denied — Vendor not verified/);
});

test("path: allow + executor failed — payment failed (distinct from blocked)", () => {
  const stages = byKey(buildTimeline(mkView({ execution: failedExec })));
  assert.equal(stages.payment.state, "failed");
  assert.equal(stages.payment.title, "Payment failed");
  assert.match(stages.payment.detail, /no settlement/);
  assert.equal(stages.payment.meta, "rcpt_1");
});

test("path: proof mismatch — stage 5 failed (tampered)", () => {
  const stages = byKey(
    buildTimeline(
      mkView({
        proof,
        proofVerification: { proofPresent: true, proofVerified: false, expectedProofId: "proof_x", actualProofId: "proof_y", reason: "mismatch" },
      }),
    ),
  );
  assert.equal(stages.proof.state, "failed");
  assert.match(stages.proof.detail, /Tampered/);
  assert.equal(stages.proof.meta, "proof_x");
});

test("path: proof corrupt — stage 5 corrupt (malformed, not mismatch)", () => {
  const stages = byKey(
    buildTimeline(
      mkView({
        proof,
        corrupt: true,
        proofVerification: { proofPresent: true, proofVerified: false, expectedProofId: null, actualProofId: null, reason: "corrupt" },
      }),
    ),
  );
  assert.equal(stages.proof.state, "corrupt");
  assert.match(stages.proof.detail, /malformed/);
  assert.equal(stages.decision.state, "done"); // corrupt blob noted, but decision row still recorded
  assert.match(stages.decision.detail, /suspect/);
});

test("path: proof absent — stage 5 skipped", () => {
  const stages = byKey(
    buildTimeline(
      mkView({
        proof: null,
        proofVerification: { proofPresent: false, proofVerified: false, expectedProofId: null, actualProofId: null, reason: "absent" },
      }),
    ),
  );
  assert.equal(stages.proof.state, "skipped");
  assert.match(stages.proof.detail, /No proof stored/);
  assert.equal(stages.proof.meta, undefined);
});

test("path: allow + not executed — payment skipped (gate-only), never 'hook'", () => {
  const stages = byKey(buildTimeline(mkView({ outcome: "allow", execution: null })));
  assert.equal(stages.payment.state, "skipped");
  assert.match(stages.payment.detail, /gate-only policy check/);
  assert.doesNotMatch(stages.payment.detail, /hook/);
});

test("path: status error — decision failed, policy + payment skipped", () => {
  const stages = byKey(
    buildTimeline(
      mkView({
        status: "error",
        outcome: null,
        decision: null,
        firedRules: [],
        facts: null,
        proof: null,
        execution: null,
        proofVerification: { proofPresent: false, proofVerified: false, expectedProofId: null, actualProofId: null, reason: "absent" },
      }),
    ),
  );
  assert.equal(stages.request.state, "done");
  assert.equal(stages.facts.state, "skipped");
  assert.equal(stages.policy.state, "skipped");
  assert.equal(stages.decision.state, "failed");
  assert.match(stages.decision.detail, /error/i);
  assert.equal(stages.proof.state, "skipped");
  assert.equal(stages.payment.state, "skipped");
});

test("facts absent → skipped; facts present → done", () => {
  assert.equal(states(mkView({ facts: null })).facts, "skipped");
  assert.equal(states(mkView({ facts: mkFacts() })).facts, "done");
});

test("policy digest surfaces as stage meta when a proof carries it", () => {
  const stages = byKey(buildTimeline(mkView({ proof })));
  assert.equal(stages.policy.meta, "policy_abc");
});

test("request stage always done and names agent/vendor/amount/category", () => {
  const stages = byKey(buildTimeline(mkView()));
  assert.equal(stages.request.state, "done");
  assert.equal(stages.request.meta, "inv_test");
  assert.match(stages.request.detail, /agent_47/);
  assert.match(stages.request.detail, /acme_corp/);
  assert.match(stages.request.detail, /office_supplies/);
});

// Minimal Facts fixture (mkView defaults facts to null).
function mkFacts(): DecisionView["facts"] {
  return {
    request_id: "inv_test",
    requesting_agent: "agent_47",
    amount: 340,
    vendor: "acme_corp",
    category: "office_supplies",
    vendor_verified: true,
    per_txn_cap: 1000,
    daily_limit: 5000,
    daily_total_so_far: 200,
    approved_categories: ["office_supplies"],
    agent_cleared_categories: ["office_supplies"],
    attestation_present: false,
  agent_identity_verified: true,
  escalation_threshold: 400,
  vendor_risk_tier: "standard",
  budgets: [],
  recent_txn_count: 0,
  velocity_limit: 6,
  duplicate_recent_count: 0,
  };
}

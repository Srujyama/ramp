/**
 * @ramp/dashboard — test fixtures (a minimal DecisionView builder).
 */
import type { DecisionView, Facts } from "./types.js";

export function mkFacts(over: Partial<Facts> = {}): Facts {
  return {
    request_id: "req_test",
    requesting_agent: "agent_47",
    amount: 340,
    vendor: "acme_corp",
    category: "office_supplies",
    vendor_verified: true,
    daily_total_so_far: 1140,
    per_txn_cap: 500,
    daily_limit: 1500,
    approved_categories: ["office_supplies", "software", "travel"],
    agent_cleared_categories: ["office_supplies", "software"],
    attestation_present: true,
    escalation_threshold: 400,
    vendor_risk_tier: "trusted",
    // `budgets` became a REQUIRED field of the frozen contract (policy.dl D7)
    // while this branch was in flight, so mkFacts stopped compiling once merged
    // with main. Empty is the right value for a fixture: a decision with no
    // additional budgets is a real, common case, and D7 is exercised properly in
    // @ramp/gate's tests.
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: 6,
    ...over,
  };
}

export function mkView(over: Partial<DecisionView> = {}): DecisionView {
  return {
    decisionId: "dec_test",
    requestId: "inv_test",
    status: "allowed",
    outcome: "allow",
    agentId: "agent_47",
    vendorId: "acme_corp",
    amount: 340,
    category: "office_supplies",
    attestationPresent: false,
    kernelId: "ts-reference",
    request: {
      vendorId: "acme_corp",
      amount: 340,
      currency: "USD",
      category: "office_supplies",
      requestingAgent: "agent_47",
    },
    facts: null,
    decision: { decision: "allow", reasons: [], firedRules: ["allow/all_conditions_met"] },
    firedRules: ["allow/all_conditions_met"],
    proof: null,
    execution: null,
    ts: "2026-07-14 10:00:00",
    corrupt: false,
    provenance: null,
    proofVerified: true,
    proofVerification: {
      proofPresent: true,
      proofVerified: true,
      expectedProofId: "proof_x",
      actualProofId: "proof_x",
      reason: "ok",
    },
    ...over,
  };
}

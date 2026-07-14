/**
 * @ramp/dashboard — test fixtures (a minimal DecisionView builder).
 */
import type { DecisionView } from "./types.js";

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

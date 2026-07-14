/**
 * @ramp/shared — Facts
 *
 * The deterministic, closed set of facts about EXACTLY ONE spend request.
 * Every field here is derived from an AUTHORITATIVE source:
 *   - structured tool args (amount, vendor, category, request_id, requesting_agent)
 *   - the vendor registry           (vendor_verified)
 *   - the ledger DB                 (daily_total_so_far)
 *   - org policy config             (per_txn_cap, daily_limit, approved_categories,
 *                                    agent_cleared_categories)
 *   - the attestation layer         (attestation_present)
 *
 * NOTHING here may come from the model's free-text narration. The whole security
 * argument ("same facts -> same answer, and the facts are true") depends on it.
 *
 * These fields map 1:1 onto the Souffle input relations in `@ramp/gate`
 * (`policy.dl`). Keep the two in lockstep.
 */
export interface Facts {
  /** Stable id of the request under evaluation, e.g. "req_9f". */
  readonly request_id: string;
  /** Agent that initiated the spend, e.g. "agent_47". */
  readonly requesting_agent: string;
  /** Requested amount, whole currency units, non-negative integer. */
  readonly amount: number;
  /** Vendor id on the request, e.g. "acme_corp". */
  readonly vendor: string;
  /** Spend category on the request, e.g. "office_supplies". */
  readonly category: string;
  /** True iff the vendor is present AND verified in the vendor registry. */
  readonly vendor_verified: boolean;
  /** Agent's total spend so far today, from the ledger DB. */
  readonly daily_total_so_far: number;
  /** Org single-transaction cap. */
  readonly per_txn_cap: number;
  /** Org daily aggregate limit. */
  readonly daily_limit: number;
  /** Categories the org has approved for spend. */
  readonly approved_categories: readonly string[];
  /** Categories THIS agent is cleared to spend in. */
  readonly agent_cleared_categories: readonly string[];
  /** True iff a TLSNotary-style attestation accompanied this request (Day 4 layer). */
  readonly attestation_present: boolean;
}

/** Field-by-field provenance for a `Facts` object — where each fact came from. */
export type FactSource =
  | "tool_args"
  | "vendor_registry"
  | "ledger_db"
  | "policy_config"
  | "attestation";

/**
 * Which authoritative source each `Facts` field is sourced from. Documentation-grade;
 * the provenance graph (Day 5) and audit trail read this to label each fact.
 */
export const FACT_SOURCES: { readonly [K in keyof Facts]: FactSource } = {
  request_id: "tool_args",
  requesting_agent: "tool_args",
  amount: "tool_args",
  vendor: "tool_args",
  category: "tool_args",
  vendor_verified: "vendor_registry",
  daily_total_so_far: "ledger_db",
  per_txn_cap: "policy_config",
  daily_limit: "policy_config",
  approved_categories: "policy_config",
  agent_cleared_categories: "policy_config",
  attestation_present: "attestation",
};

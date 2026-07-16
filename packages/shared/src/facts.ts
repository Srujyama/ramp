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
  /**
   * Org threshold above which a spend needs a human, even though it is within
   * every hard cap. From `policy_limits`.
   *
   * This is what lets `per_txn_cap` mean one thing again. Before it, the cap had
   * to be both "the most an agent may spend unattended" and "the most an agent
   * may spend" — two different numbers wearing one name, which is how caps get
   * argued upward until they mean nothing.
   */
  readonly escalation_threshold: number;
  /**
   * The vendor's risk tier from the registry: `"trusted"`, `"standard"`, or
   * `"elevated"`. An unregistered vendor is `"unknown"` (and denies on
   * `vendor_not_verified` long before tier matters).
   *
   * Verified is not the same as familiar — a vendor can be exactly who they say
   * and still be one we started paying yesterday.
   */
  readonly vendor_risk_tier: string;
  /**
   * Every ADDITIONAL budget this spend must fit under, beyond the agent's daily
   * limit. Sorted by `(scope, key)` — see {@link BudgetLine}.
   *
   * ============================================================================
   * WHY A LIST AND NOT MORE SCALARS
   * ============================================================================
   * A category budget, a vendor cap, and a monthly limit are all the SAME SHAPE:
   * "spend so far + this amount vs a limit". Adding a `category_budget` /
   * `category_spent` pair, then a `vendor_budget` / `vendor_spent` pair, then a
   * `monthly_*` pair, means three near-identical rules in four kernels — twelve
   * hand-maintained copies of one idea, drifting independently. This repo has
   * been bitten by exactly that shape twice already (the duplicated fact-source
   * port; the two canonical encoders).
   *
   * One list, one rule (`policy.dl` D7). A new budget scope is a row in a table,
   * not an edit to four kernels.
   *
   * ============================================================================
   * WHY `agent_daily` IS *NOT* IN HERE
   * ============================================================================
   * It could be — it is the same shape. It stays as the `daily_limit` /
   * `daily_total_so_far` scalars because it predates this generalisation and
   * because `deny/daily_limit_exceeded: 1140 + 400 > 1500` is quoted verbatim in
   * PITCH.md and named in 15 files. Rewriting the pitch's most-quoted line to buy
   * nothing behavioural is churn, not craft.
   *
   * That leaves two mechanisms for one concept, which is the smell described
   * above — so the boundary is enforced rather than trusted: the ledger NEVER
   * emits an `agent_daily` line, and a test asserts it. The two cannot disagree
   * because only one of them ever speaks about that scope.
   */
  readonly budgets: readonly BudgetLine[];
  /**
   * How many payments this agent has already settled inside the org's velocity
   * window (from the ledger). A rate signal, not an amount signal.
   *
   * Velocity is a different fraud shape than any cap: a compromised agent draining
   * an account does it not with one giant payment (the cap stops that) but with a
   * flurry of small ones under every limit. Counting the flurry is the control.
   */
  readonly recent_txn_count: number;
  /**
   * The count at/above which the next payment needs a human (org policy). A burst
   * is not necessarily fraud — a batch run is legitimate — so this ESCALATES
   * rather than denies: hold it, let a person look, don't refuse a real workload.
   */
  readonly velocity_limit: number;
  /**
   * How many ALREADY-SETTLED payments match this one — same vendor, same amount,
   * same category — inside the dedup window (a ledger read).
   *
   * The double-payment is the oldest AP fraud there is: submit the same invoice
   * twice, or a compromised agent re-fires a legitimate-looking payment. No cap,
   * budget, or rate limit sees it — every copy is individually fine. Matching the
   * copy is the control.
   */
  readonly duplicate_recent_count: number;
}

/**
 * One budget the spend must fit under.
 *
 * `spent` is an authoritative ledger read, never a claim — same rule as every
 * other gating fact.
 */
export interface BudgetLine {
  /**
   * What the budget is scoped to: `"category_daily"`, `"vendor_daily"`,
   * `"agent_monthly"`. Deliberately a string, not a union: a new scope should be
   * a row in the `budgets` table, and the kernel's rule is generic over it — it
   * compares numbers and reports the scope, it does not need to know the
   * taxonomy. `"agent_daily"` is reserved and never emitted (see `Facts.budgets`).
   */
  readonly scope: string;
  /** What it applies to: the category id, vendor id, or agent id. */
  readonly key: string;
  /** The cap, integer whole units. */
  readonly limit: number;
  /** Spend already counted against this budget, from the ledger. */
  readonly spent: number;
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
  escalation_threshold: "policy_config",
  vendor_risk_tier: "vendor_registry",
  budgets: "ledger_db",
  recent_txn_count: "ledger_db",
  velocity_limit: "policy_config",
  duplicate_recent_count: "ledger_db",
};

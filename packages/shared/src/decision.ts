/**
 * @ramp/shared — Decision
 *
 * The result of running one `Facts` object through the policy kernel.
 * `deny` dominates: if the kernel derived any deny, `decision` is `"deny"`.
 */
export type DecisionOutcome = "allow" | "deny";

/**
 * Stable identifiers for every rule in the kernel. These strings are part of the
 * contract: they appear in `Decision.firedRules`, the dashboard, and audit logs,
 * and MUST match between the TS reference kernel and the WASM kernel.
 */
export type RuleId =
  | "allow/all_conditions_met"
  | "deny/vendor_not_verified"
  | "deny/over_per_txn_cap"
  | "deny/agent_uncleared_for_category"
  | "deny/category_not_approved"
  | "deny/daily_limit_exceeded";

export interface Decision {
  /** Final outcome. `"deny"` if any deny rule fired, else `"allow"`. */
  readonly decision: DecisionOutcome;
  /**
   * Human-readable reasons, one per fired rule, in rule-evaluation order.
   * For a deny these are the deny reasons; for an allow, a single confirmation.
   */
  readonly reasons: readonly string[];
  /** The `RuleId`s that fired, in rule-evaluation order. */
  readonly firedRules: readonly RuleId[];
}

/** Narrow helper: did this decision allow the spend? */
export function isAllowed(d: Decision): boolean {
  return d.decision === "allow";
}

/** Narrow helper: did this decision deny the spend? (deny dominates) */
export function isDenied(d: Decision): boolean {
  return d.decision === "deny";
}

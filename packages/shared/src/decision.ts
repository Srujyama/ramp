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
  | "deny/daily_limit_exceeded"
  /**
   * The `Facts` are not well-formed — a numeric field is not a finite,
   * non-negative integer. Evaluated FIRST and alone; we do not reason about
   * garbage.
   *
   * Exists to close a real fail-open found by the property tests. Souffle's
   * `number` type is an INTEGER: NaN, Infinity and floats are unrepresentable in
   * `policy.dl`, so its rules never have to consider them. TypeScript's `number`
   * is IEEE-754 and admits all three — and NaN is poison, because every
   * comparison against it is false. `NaN > per_txn_cap` is false, and
   * `daily_total + NaN > daily_limit` is false, so BOTH numeric denies silently
   * failed to fire and the kernel returned "all_conditions_met: amount NaN
   * within cap 500". A NaN was payable.
   *
   * The TS kernel must therefore enforce at RUNTIME what Souffle enforces in its
   * TYPE SYSTEM. That is the whole reason this rule has no D-number in policy.dl:
   * it is not a policy, it is the mirror paying for a difference between the two
   * languages' number types.
   */
  | "deny/malformed_facts"
  /**
   * No VERIFIED attestation accompanied this request (@ramp/attestation, pillar 4).
   *
   * Added deliberately, as a coordinated change to the frozen contract. Without
   * it, `attestation_present` was declared in `Facts` and in `policy.dl` but
   * consulted by no rule — pillar 4 was decorative, and the pitch's claim that
   * cryptographic attestation gates spend was not true of the code.
   *
   * It is appended LAST in the evaluation order rather than slotted next to
   * `vendor_not_verified` (its thematic sibling — both are authenticity checks)
   * purely to preserve the existing byte-stable ordering of `reasons`/
   * `firedRules`. Order affects only the reason list, never allow/deny.
   */
  | "deny/attestation_invalid";

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

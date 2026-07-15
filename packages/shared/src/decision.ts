/**
 * @ramp/shared — Decision
 *
 * The result of running one `Facts` object through the policy kernel.
 * `deny` dominates: if the kernel derived any deny, `decision` is `"deny"`.
 */
/**
 * The three things policy can say.
 *
 * `escalate` is not "deny politely" and it is not "allow with a warning" — it is
 * a distinct verdict meaning *the rulebook cannot settle this; a human must.*
 * The payment is HELD: nothing executes, and nothing is recorded as allowed.
 *
 * It exists because the honest answer to some requests is neither yes nor no.
 * Without it, every borderline case has to be crammed into one of two boxes, and
 * both choices are bad: deny everything unusual and the gate is unusable, so
 * someone raises the caps until it is useless; allow everything not explicitly
 * forbidden and the gate is a formality. A third outcome lets policy be strict
 * AND practical, because "ask a person" stops being a policy failure and becomes
 * a policy *result*.
 *
 * ORDERING (see the kernel): **deny > escalate > allow**. Deny still dominates
 * everything — an escalation can never rescue a request that a deny rule
 * rejected, because that would let a human approve something policy forbids.
 * Escalate only outranks allow.
 */
export type DecisionOutcome = "allow" | "deny" | "escalate";

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
  | "deny/attestation_invalid"
  /**
   * The amount is within every hard cap but above the org's escalation
   * threshold — large enough that a person should look at it.
   *
   * This is the rule that makes the caps honest. Before it, `per_txn_cap` had to
   * be simultaneously "the most an agent may ever spend unattended" and "the
   * most an agent may ever spend", which are not the same number and pretending
   * they were is how caps drift upward until they mean nothing.
   */
  | "escalate/over_escalation_threshold"
  /**
   * The vendor is verified and registered, but carries an elevated risk tier
   * (e.g. recently onboarded).
   *
   * Verified is not the same as familiar. A vendor can be genuinely who they
   * claim — real domain, real attestation, every check green — and still be one
   * we started paying yesterday. That is exactly the shape of a supplier-
   * impersonation setup, and exactly the case where a human glance is cheap and
   * a mistake is not.
   */
  | "escalate/elevated_risk_vendor";

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

/** Narrow helper: does this decision need a human? (the payment is HELD) */
export function isEscalated(d: Decision): boolean {
  return d.decision === "escalate";
}

/**
 * True iff money may move on this decision.
 *
 * Use this rather than `!isDenied(d)`. When `escalate` was added, every
 * `!isDenied` in the codebase silently started meaning "allow OR escalate" —
 * i.e. it would have PAID OUT every request that policy said a human must review
 * first. That is the single most dangerous shape a third outcome introduces:
 * two-valued logic quietly mis-classifying the new third value, in the
 * permissive direction, with no error anywhere.
 *
 * `allow` is the only verdict that moves money. Say so explicitly.
 */
export function permitsPayment(d: Decision): boolean {
  return d.decision === "allow";
}

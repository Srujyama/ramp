/**
 * @ramp/gate — ReferenceKernel
 *
 * The golden oracle: a pure, deterministic TypeScript implementation of the
 * policy kernel that is a LINE-FOR-LINE mirror of `datalog/policy.dl`.
 *
 * Contract (from @ramp/shared PolicyKernel):
 *   - `evaluate` is SYNCHRONOUS and PURE: no I/O, no clock, no randomness.
 *   - DETERMINISTIC: identical `Facts` -> identical `Decision`, every time.
 *   - `deny` dominates: any deny rule makes the decision `"deny"`.
 *
 * Deny-evaluation order is FIXED and part of the contract so that `reasons`
 * and `firedRules` are byte-stable across runs and implementations:
 *   1. deny/vendor_not_verified          (policy.dl D1)
 *   2. deny/over_per_txn_cap             (policy.dl D2)
 *   3. deny/category_not_approved        (policy.dl D4)
 *   4. deny/agent_uncleared_for_category (policy.dl D3)
 *   5. deny/daily_limit_exceeded         (policy.dl D5)
 *   6. deny/attestation_invalid          (policy.dl D6)
 *   7. deny/budget_exceeded              (policy.dl D7), one per broken budget,
 *      in the ledger's (scope, key) order
 * ...then, only if NO deny fired:
 *   8. escalate/over_escalation_threshold (policy.dl E1)
 *   9. escalate/elevated_risk_vendor      (policy.dl E2)
 *  10. escalate/velocity_exceeded         (policy.dl E3)
 *  11. escalate/possible_duplicate        (policy.dl E4)
 *
 * The lattice is **deny > escalate > allow**. Order within a tier affects only
 * the reason list; the tiers themselves are the semantics. Deny dominates
 * escalate deliberately: an escalation must never hand a human a request that
 * policy already rejected, or every deny rule becomes a suggestion.
 * D6 is appended last rather than placed beside its thematic sibling D1 (both are
 * authenticity checks) solely to keep the pre-existing ordering byte-stable.
 */
import type { Facts, Decision, RuleId, PolicyKernel } from "@ramp/shared";

/** One fired-rule record: its stable id plus a human-readable reason. */
interface FiredRule {
  readonly id: RuleId;
  readonly reason: string;
}

/**
 * The numeric `Facts` fields. All must be finite, non-negative integers — the
 * repo-wide "money is integer whole units" invariant, which exists so the
 * kernel's arithmetic is exact.
 */
const NUMERIC_FACTS = [
  "amount",
  "daily_total_so_far",
  "per_txn_cap",
  "daily_limit",
] as const satisfies ReadonlyArray<keyof Facts>;

/**
 * Names the numeric fields that are not finite, non-negative integers.
 *
 * WHY THIS EXISTS (a real fail-open, found by the property tests):
 * Souffle's `number` is an INTEGER type, so `policy.dl` never has to consider
 * NaN, Infinity, or floats — they cannot be written down. TypeScript's `number`
 * is IEEE-754 and admits all three, and NaN is poison: EVERY comparison against
 * it is false. So with `amount: NaN`, D2's `amount > per_txn_cap` was false and
 * D5's `daily_total + amount > daily_limit` was false — neither deny fired, no
 * other rule looks at amount, and the kernel returned
 * `all_conditions_met: amount NaN within cap 500`. A NaN was payable.
 *
 * It was not reachable through the hook (`isSpendRequest` rejects a non-finite
 * amount), so this is defence in depth rather than a live exploit. But the
 * kernel is the authority: it must not depend on a caller remembering to check.
 */
function malformedNumerics(facts: Facts): string[] {
  return NUMERIC_FACTS.filter((key) => {
    const v = facts[key];
    return typeof v !== "number" || !Number.isInteger(v) || v < 0;
  });
}

export class ReferenceKernel implements PolicyKernel {
  evaluate(facts: Facts): Decision {
    const denies: FiredRule[] = [];

    // ---- D0: malformed facts. Evaluated FIRST and returned ALONE ------------
    // We do not reason about garbage. If a number is not a number, every
    // downstream comparison is meaningless (and, with NaN, silently permissive),
    // so there is nothing useful to say beyond "these facts are not evaluable."
    const malformed = malformedNumerics(facts);
    if (malformed.length > 0) {
      return {
        decision: "deny",
        reasons: [
          `malformed_facts: ${malformed.join(", ")} must be finite, non-negative ` +
            `integers (money is whole units); refusing to evaluate`,
        ],
        firedRules: ["deny/malformed_facts"],
      };
    }

    // Derived helper (policy.dl `requesting_agent_uncleared_for_category`):
    // the agent is cleared iff the request's category is in its cleared set.
    const agentClearedForCategory =
      facts.agent_cleared_categories.includes(facts.category);
    const categoryApproved = facts.approved_categories.includes(facts.category);

    // ---- Deny triggers, in the FROZEN evaluation order ----------------------

    // D1 (policy.dl): vendor not verified in the registry.
    if (!facts.vendor_verified) {
      denies.push({
        id: "deny/vendor_not_verified",
        reason: `vendor_not_verified: vendor "${facts.vendor}" is not verified in the registry`,
      });
    }

    // D2 (policy.dl): single transaction over the per-transaction cap.
    if (facts.amount > facts.per_txn_cap) {
      denies.push({
        id: "deny/over_per_txn_cap",
        reason: `over_per_txn_cap: amount ${facts.amount} > per_txn_cap ${facts.per_txn_cap}`,
      });
    }

    // D4 (policy.dl): category not on the approved list.
    if (!categoryApproved) {
      denies.push({
        id: "deny/category_not_approved",
        reason: `category_not_approved: category "${facts.category}" is not on the org's approved list`,
      });
    }

    // D3 (policy.dl): requesting agent not cleared for the request's category.
    if (!agentClearedForCategory) {
      denies.push({
        id: "deny/agent_uncleared_for_category",
        reason: `agent_uncleared_for_category: agent "${facts.requesting_agent}" is not cleared for category "${facts.category}"`,
      });
    }

    // D5 (policy.dl): this request would push the daily total over the limit.
    if (facts.daily_total_so_far + facts.amount > facts.daily_limit) {
      denies.push({
        id: "deny/daily_limit_exceeded",
        reason: `daily_limit_exceeded: ${facts.daily_total_so_far} + ${facts.amount} > daily_limit ${facts.daily_limit}`,
      });
    }

    // D6 (policy.dl): no VERIFIED attestation accompanies this request.
    // `attestation_present` is the attestation layer's verdict, established out
    // of band (@ramp/attestation). Missing, malformed, expired, forged, and
    // unbound all collapse to the same `false` here — and false denies.
    if (!facts.attestation_present) {
      denies.push({
        id: "deny/attestation_invalid",
        reason:
          `attestation_invalid: no verified attestation binds this invoice to vendor ` +
          `"${facts.vendor}" — refusing to pay on an unattested document`,
      });
    }

    // D7 (policy.dl): any ADDITIONAL budget this spend would break.
    //
    // Generic over scope on purpose — see Facts.budgets. The list arrives sorted
    // by (scope, key) from the ledger, and that ordering is load-bearing: reasons
    // and firedRules are byte-stable across runs and kernels, and an unsorted
    // list would make the SAME facts produce a different Decision depending on
    // SQLite's row order. That is exactly the non-determinism the whole design
    // exists to rule out, and it would be invisible until a bundle failed to
    // re-verify on someone else's machine.
    for (const b of facts.budgets) {
      if (b.spent + facts.amount > b.limit) {
        denies.push({
          id: "deny/budget_exceeded",
          reason:
            `budget_exceeded: ${b.scope} budget for "${b.key}" — ` +
            `${b.spent} + ${facts.amount} > ${b.limit}`,
        });
      }
    }

    // ---- ESCALATE triggers (policy.dl E1, E2) -------------------------------
    // Collected BEFORE the deny check returns, but consulted only AFTER it — see
    // the ordering note below. Gathering them here keeps the rule list readable
    // in evaluation order.
    const escalations: FiredRule[] = [];

    // E1: within every hard cap, but big enough that a person should look.
    if (facts.amount > facts.escalation_threshold) {
      escalations.push({
        id: "escalate/over_escalation_threshold",
        reason:
          `over_escalation_threshold: amount ${facts.amount} > escalation_threshold ` +
          `${facts.escalation_threshold} (within the ${facts.per_txn_cap} cap, but a human must approve)`,
      });
    }

    // E2: verified, registered — and new enough to be worth a glance.
    if (facts.vendor_risk_tier === "elevated") {
      escalations.push({
        id: "escalate/elevated_risk_vendor",
        reason:
          `elevated_risk_vendor: vendor "${facts.vendor}" is verified but carries risk tier ` +
          `"${facts.vendor_risk_tier}" — a human must approve`,
      });
    }

    // E3: the agent is spending FAST. Not big — fast. The count is the signal.
    if (facts.recent_txn_count >= facts.velocity_limit) {
      escalations.push({
        id: "escalate/velocity_exceeded",
        reason:
          `velocity_exceeded: agent "${facts.requesting_agent}" has settled ` +
          `${facts.recent_txn_count} payment(s) in the velocity window (limit ` +
          `${facts.velocity_limit}) — a human must approve the next`,
      });
    }

    // E4: this looks like a DOUBLE PAYMENT — same vendor, amount, category already
    // settled recently. No cap or budget sees it; every copy is individually fine.
    if (facts.duplicate_recent_count >= 1) {
      escalations.push({
        id: "escalate/possible_duplicate",
        reason:
          `possible_duplicate: ${facts.duplicate_recent_count} settled payment(s) already ` +
          `match vendor "${facts.vendor}", amount ${facts.amount}, category ` +
          `"${facts.category}" in the dedup window — a human must confirm this is not a repeat`,
      });
    }

    // ---- DENY DOMINATES — including over escalate ---------------------------
    // The ordering is deny > escalate > allow, and the deny check comes first for
    // a reason worth stating: if an escalation could outrank a deny, a human
    // would be handed a request that POLICY ALREADY REJECTED and asked to
    // approve it. That converts every deny rule into a suggestion, and the whole
    // point of a deterministic kernel is that its denials are not negotiable.
    //
    // A denied request is denied. Nobody gets asked.
    if (denies.length > 0) {
      return {
        decision: "deny",
        reasons: denies.map((d) => d.reason),
        firedRules: denies.map((d) => d.id),
      };
    }

    // ---- ESCALATE: no deny fired, but this needs a person -------------------
    // Note what is NOT here: the escalation reasons do not include the allow
    // reason. An escalated request is not "allowed pending review" — it is not
    // allowed at all yet. Saying otherwise in the audit trail would be the
    // beginning of treating a held payment as a made one.
    if (escalations.length > 0) {
      return {
        decision: "escalate",
        reasons: escalations.map((e) => e.reason),
        firedRules: escalations.map((e) => e.id),
      };
    }

    // ---- ALLOW: every condition held AND nothing needs a human --------------
    // (No deny fired => amount<=cap, category approved, vendor verified, agent
    //  cleared, daily_total+amount<=daily_limit, attestation verified. No
    //  escalation fired => within the escalation threshold, vendor not elevated.)
    return {
      decision: "allow",
      reasons: [
        `all_conditions_met: amount ${facts.amount} within cap ${facts.per_txn_cap}, ` +
          `category "${facts.category}" approved and agent "${facts.requesting_agent}" cleared, ` +
          `vendor "${facts.vendor}" verified, ` +
          `daily ${facts.daily_total_so_far} + ${facts.amount} <= ${facts.daily_limit}, ` +
          `attestation verified`,
      ],
      firedRules: ["allow/all_conditions_met"],
    };
  }
}

/** A ready-to-use singleton instance of the reference kernel. */
export const referenceKernel: PolicyKernel = new ReferenceKernel();

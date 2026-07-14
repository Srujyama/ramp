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
 * Order affects only the reason list, never allow/deny (deny dominates regardless).
 */
import type { Facts, Decision, RuleId, PolicyKernel } from "@ramp/shared";

/** One fired-rule record: its stable id plus a human-readable reason. */
interface FiredRule {
  readonly id: RuleId;
  readonly reason: string;
}

/**
 * Pure evaluation of a single `Facts` object against the policy rules.
 *
 * Mirrors `datalog/policy.dl`: the same predicates, the same arithmetic
 * (`<=` / `>` on integer whole currency units), the same deny triggers.
 */
export class ReferenceKernel implements PolicyKernel {
  evaluate(facts: Facts): Decision {
    const denies: FiredRule[] = [];

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

    // ---- deny dominates -----------------------------------------------------
    if (denies.length > 0) {
      return {
        decision: "deny",
        reasons: denies.map((d) => d.reason),
        firedRules: denies.map((d) => d.id),
      };
    }

    // ---- ALLOW: every condition held (policy.dl `allow`) --------------------
    // (No deny fired => all of: amount<=cap, category approved, vendor verified,
    //  agent cleared, and daily_total+amount<=daily_limit hold.)
    return {
      decision: "allow",
      reasons: [
        `all_conditions_met: amount ${facts.amount} within cap ${facts.per_txn_cap}, ` +
          `category "${facts.category}" approved and agent "${facts.requesting_agent}" cleared, ` +
          `vendor "${facts.vendor}" verified, ` +
          `daily ${facts.daily_total_so_far} + ${facts.amount} <= ${facts.daily_limit}`,
      ],
      firedRules: ["allow/all_conditions_met"],
    };
  }
}

/** A ready-to-use singleton instance of the reference kernel. */
export const referenceKernel: PolicyKernel = new ReferenceKernel();

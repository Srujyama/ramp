/**
 * @ramp/gate — explain.ts (the counterfactual explainer)
 *
 * "Why did the gate say no, and what is the smallest change that flips it?"
 *
 * A denied payment is only half an answer. The other half — the one an operator
 * actually acts on — is the counterfactual: *at what amount would this have
 * settled unattended? which single fact is holding it back? can money alone fix
 * it, or is it a categorical block (unverified vendor, missing attestation) that
 * no smaller amount clears?*
 *
 * THE HONESTY RULE (why this is not just string-parsing the reasons):
 * every counterfactual this module reports is CONFIRMED BY RE-RUNNING THE KERNEL.
 * We never *assert* "it would have allowed at $X"; we perturb one fact, hand the
 * new Facts back to the SAME deterministic kernel, and report the flip only if the
 * kernel agrees. The explainer cannot be more permissive than the gate, because
 * the gate is the thing answering. This mirrors the whole repo: the kernel is the
 * authority; everything else asks it.
 *
 * PURE: no I/O, no clock, no randomness. `facts` in, `Explanation` out. The
 * `pnpm why` CLI reads the facts from the ledger and hands them here; this module
 * knows nothing about SQLite.
 */
import type { Facts, Decision, DecisionOutcome, RuleId, PolicyKernel } from "@ramp/shared";

/** One fired rule, with the concrete fix that would clear it. */
export interface RuleExplanation {
  /** Stable rule id, e.g. `deny/over_per_txn_cap`. */
  readonly id: RuleId;
  /** The kernel's verbatim reason string (the numbers as they actually were). */
  readonly reason: string;
  /** The smallest change, in words, that would clear THIS rule. */
  readonly fix: string;
  /**
   * If this rule is governed by the request AMOUNT, the largest amount that would
   * clear it on its own. Absent for categorical rules (vendor/category/agent/
   * attestation/velocity/duplicate/elevated) that no amount can fix.
   */
  readonly clearsAtAmountAtMost?: number;
  /**
   * True iff no change to `amount` clears this rule — it needs a categorical fact
   * to change (verify the vendor, approve the category, attach an attestation…).
   */
  readonly categorical: boolean;
}

/** The kernel-confirmed counterfactual: what would flip the whole verdict. */
export interface Counterfactual {
  /**
   * The single largest amount that flips the WHOLE verdict to `allow`, found by
   * probing the kernel — or `null` if NO amount can (a categorical blocker
   * remains). When non-null and below the requested amount, this is the headline
   * number: "it would have settled unattended at any amount ≤ this".
   */
  readonly maxAllowAmount: number | null;
  /**
   * The largest amount that flips the verdict to at least `escalate` (i.e. stops
   * being a hard `deny` so a human could approve it) — or `null` if no amount
   * lifts it out of deny. `null` whenever the outcome is already not a deny.
   */
  readonly maxNonDenyAmount: number | null;
  /**
   * Categorical blockers that amount cannot fix — the rule ids that still fire
   * when the amount is dropped to 0. Empty when the block is purely about amount.
   */
  readonly categoricalBlockers: readonly RuleId[];
}

/**
 * For a decision that was NOT denied, the nearest amount that would make it worse —
 * "how close was this to being stopped?". The mirror image of the counterfactual:
 * the counterfactual probes DOWN (what would allow a stopped payment); this probes
 * UP (what would stop an allowed/held one). Kernel-confirmed the same way.
 */
export interface NearestStop {
  /** The smallest amount (> the requested amount) whose verdict is worse. */
  readonly amount: number;
  /** The worse verdict at that amount — `escalate` (held) or `deny`. */
  readonly outcome: DecisionOutcome;
  /** How much more than the requested amount that is (the safety margin). */
  readonly margin: number;
  /** The first rule that fires at that amount. */
  readonly rule: RuleId;
}

/** A full, provable explanation of one decision. */
export interface Explanation {
  readonly outcome: DecisionOutcome;
  /** Every rule the kernel fired, each with its concrete fix. */
  readonly firedRules: readonly RuleExplanation[];
  readonly counterfactual: Counterfactual;
  /**
   * For an `allow` (nearest stop = escalate or deny) or an `escalate` (nearest
   * deny), the smallest amount that would make the verdict worse — the safety
   * margin. `null` for a `deny` (nothing worse to reach) or when no amount-governed
   * rule can worsen it within a sane bound.
   */
  readonly nearestStop: NearestStop | null;
  /** A one-line, operator-facing summary that leads with the money. */
  readonly headline: string;
}

/** Rules whose trigger is (partly) the request amount — a smaller amount can clear them. */
const AMOUNT_GOVERNED = new Set<RuleId>([
  "deny/over_per_txn_cap",
  "deny/daily_limit_exceeded",
  "deny/budget_exceeded",
  "escalate/over_escalation_threshold",
]);

/** Non-negative integer headroom, floored at 0 (a negative cap means "no room at all"). */
function headroom(limit: number, alreadyUsed: number): number {
  return Math.max(0, limit - alreadyUsed);
}

/**
 * The per-rule fix + amount threshold. `budgetCursor` walks `facts.budgets` in the
 * SAME order the kernel fired them, so repeated `deny/budget_exceeded` rules each
 * map to their own budget line rather than all reporting the first.
 */
function explainRule(
  id: RuleId,
  reason: string,
  facts: Facts,
  nextBrokenBudget: () => { scope: string; key: string; limit: number; spent: number } | undefined,
): RuleExplanation {
  switch (id) {
    case "deny/over_per_txn_cap":
      return {
        id,
        reason,
        categorical: false,
        clearsAtAmountAtMost: facts.per_txn_cap,
        fix: `request ≤ ${facts.per_txn_cap} (the per-transaction cap)`,
      };
    case "deny/daily_limit_exceeded": {
      const room = headroom(facts.daily_limit, facts.daily_total_so_far);
      return {
        id,
        reason,
        categorical: false,
        clearsAtAmountAtMost: room,
        fix:
          room > 0
            ? `request ≤ ${room} (today's remaining daily headroom), or wait for tomorrow`
            : `today's ${facts.daily_total_so_far} already meets the ${facts.daily_limit} daily limit — no room until tomorrow`,
      };
    }
    case "deny/budget_exceeded": {
      const b = nextBrokenBudget();
      const room = b ? headroom(b.limit, b.spent) : 0;
      return {
        id,
        reason,
        categorical: false,
        clearsAtAmountAtMost: room,
        fix: b
          ? `request ≤ ${room} against the ${b.scope} budget for "${b.key}" (${b.spent}/${b.limit} used)`
          : `reduce the amount to fit the broken budget`,
      };
    }
    case "escalate/over_escalation_threshold":
      return {
        id,
        reason,
        categorical: false,
        clearsAtAmountAtMost: facts.escalation_threshold,
        fix: `request ≤ ${facts.escalation_threshold} to settle unattended (above it, a human must approve)`,
      };
    case "deny/vendor_not_verified":
      return {
        id,
        reason,
        categorical: true,
        fix: `verify vendor "${facts.vendor}" in the vendor registry`,
      };
    case "deny/category_not_approved":
      return {
        id,
        reason,
        categorical: true,
        fix: `add category "${facts.category}" to the org's approved list`,
      };
    case "deny/agent_uncleared_for_category":
      return {
        id,
        reason,
        categorical: true,
        fix: `clear agent "${facts.requesting_agent}" for category "${facts.category}"`,
      };
    case "deny/attestation_invalid":
      return {
        id,
        reason,
        categorical: true,
        fix: `attach a verified attestation binding the invoice to vendor "${facts.vendor}"`,
      };
    case "escalate/elevated_risk_vendor":
      return {
        id,
        reason,
        categorical: true,
        fix: `promote vendor "${facts.vendor}" off the "elevated" risk tier (a human must approve until then)`,
      };
    case "escalate/velocity_exceeded":
      return {
        id,
        reason,
        categorical: true,
        fix: `settle fewer than ${facts.velocity_limit} payments in the velocity window (currently ${facts.recent_txn_count})`,
      };
    case "escalate/possible_duplicate":
      return {
        id,
        reason,
        categorical: true,
        fix: `confirm this is not a repeat — ${facts.duplicate_recent_count} matching payment(s) already settled in the dedup window`,
      };
    case "deny/malformed_facts":
      return {
        id,
        reason,
        categorical: true,
        fix: `the facts are not evaluable (a numeric fact is not a whole non-negative number)`,
      };
    default:
      return { id, reason, categorical: true, fix: `(no counterfactual known for ${id})` };
  }
}

/**
 * The largest `amount` in `[0, ceiling]` for which `predicate(kernel(facts@amount))`
 * holds, assuming the predicate is MONOTONE in amount (true for small amounts,
 * false once it grows) — which every amount-governed rule is: lowering the amount
 * only ever relaxes a cap, never trips a new one. Returns `null` if even amount 0
 * fails the predicate (a categorical blocker remains). Kernel-confirmed at every
 * step: we never reason about the flip, we ask the kernel.
 */
function largestAmountSuchThat(
  facts: Facts,
  kernel: PolicyKernel,
  ceiling: number,
  predicate: (d: Decision) => boolean,
): number | null {
  const at = (amount: number) => predicate(kernel.evaluate({ ...facts, amount }));
  if (!at(0)) return null; // categorical: no amount helps
  if (at(ceiling)) return ceiling; // already satisfied at the requested amount
  // Binary search the boundary in [0, ceiling]. `lo` always satisfies, `hi` never.
  let lo = 0;
  let hi = ceiling;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Severity of a verdict on the deny > escalate > allow lattice (higher = worse). */
function severity(o: DecisionOutcome): number {
  return o === "deny" ? 2 : o === "escalate" ? 1 : 0;
}

/**
 * The smallest amount ABOVE `facts.amount` whose verdict is strictly WORSE than
 * the current one — the mirror of {@link largestAmountSuchThat}, probing up. Relies
 * on the same monotonicity (raising the amount never improves a verdict), so
 * "is worse than baseline" is monotone and binary-searchable. `null` for a `deny`
 * (nothing worse to reach). Kernel-confirmed at the boundary.
 */
function nearestStopFor(facts: Facts, kernel: PolicyKernel, baseline: DecisionOutcome): NearestStop | null {
  const baseSev = severity(baseline);
  if (baseSev === 2) return null; // already denied — nothing worse
  // An amount above the per-txn cap always denies (D2), so cap+1 is a guaranteed
  // "worse" ceiling to bracket the search. (allow/escalate imply amount ≤ cap.)
  const ceiling = facts.per_txn_cap + 1;
  const worseAt = (amt: number) =>
    severity(kernel.evaluate({ ...facts, amount: amt }).decision) > baseSev;
  if (!worseAt(ceiling)) return null; // defensive; should not happen for valid facts
  let lo = facts.amount; // not worse (this is the baseline)
  let hi = ceiling; // worse
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (worseAt(mid)) hi = mid;
    else lo = mid;
  }
  const at = kernel.evaluate({ ...facts, amount: hi });
  // A worse-than-allow verdict always has at least one fired rule; guard anyway.
  const rule = at.firedRules.find((id) => id !== "allow/all_conditions_met") ?? at.firedRules[0];
  if (rule === undefined) return null;
  return {
    amount: hi,
    outcome: at.decision,
    margin: hi - facts.amount,
    rule,
  };
}

/**
 * Explain one decision: annotate every fired rule with its fix, and compute the
 * kernel-confirmed counterfactual (the largest amount that would flip the verdict,
 * plus the categorical blockers no amount can clear).
 *
 * `decision` must be the verdict the kernel produced for `facts`. The caller (the
 * `pnpm why` CLI) reads both from the append-only decision log, so the explanation
 * is about the decision that was ACTUALLY recorded, not a fresh re-evaluation that
 * might see different ledger state.
 */
export function explainDecision(
  facts: Facts,
  decision: Decision,
  kernel: PolicyKernel,
): Explanation {
  // Walk broken budgets in fired order so repeated budget_exceeded rules line up.
  const brokenBudgets = facts.budgets.filter((b) => b.spent + facts.amount > b.limit);
  let budgetIdx = 0;
  const nextBrokenBudget = () => brokenBudgets[budgetIdx++];

  const firedRules: RuleExplanation[] = decision.firedRules
    .filter((id) => id !== "allow/all_conditions_met")
    .map((id, i) => explainRule(id, decision.reasons[i] ?? "", facts, nextBrokenBudget));

  // Counterfactual — only meaningful when the verdict is not already `allow`.
  const ceiling = facts.amount;
  const isAllow = (d: Decision) => d.decision === "allow";
  const isNotDeny = (d: Decision) => d.decision !== "deny";

  const maxAllowAmount =
    decision.decision === "allow"
      ? facts.amount
      : largestAmountSuchThat(facts, kernel, ceiling, isAllow);
  const maxNonDenyAmount =
    decision.decision === "deny"
      ? largestAmountSuchThat(facts, kernel, ceiling, isNotDeny)
      : null;

  // Categorical blockers = rules that STILL fire at amount 0 (amount can't fix them).
  const atZero = kernel.evaluate({ ...facts, amount: 0 });
  const categoricalBlockers =
    decision.decision === "allow"
      ? []
      : atZero.firedRules.filter((id) => id !== "allow/all_conditions_met" && !AMOUNT_GOVERNED.has(id));

  const counterfactual: Counterfactual = {
    maxAllowAmount,
    maxNonDenyAmount,
    categoricalBlockers,
  };

  // How close was this to being stopped? Meaningful only when it was NOT denied.
  const nearestStop =
    decision.decision === "deny" ? null : nearestStopFor(facts, kernel, decision.decision);

  return {
    outcome: decision.decision,
    firedRules,
    counterfactual,
    nearestStop,
    headline: buildHeadline(facts, decision, counterfactual, nearestStop),
  };
}

/** How a nearest-stop reads in prose. */
function stopVerb(outcome: DecisionOutcome): string {
  return outcome === "deny" ? "denied" : "held for a human";
}

/** The one-line, money-first summary. */
function buildHeadline(
  facts: Facts,
  decision: Decision,
  cf: Counterfactual,
  nearestStop: NearestStop | null,
): string {
  if (decision.decision === "allow") {
    if (nearestStop) {
      return `Allowed at ${facts.amount} — ${nearestStop.margin} short of being ${stopVerb(nearestStop.outcome)} (that starts at ${nearestStop.amount}).`;
    }
    return `Allowed: settled unattended at ${facts.amount}.`;
  }
  const asked = facts.amount;
  if (decision.decision === "escalate") {
    const tail =
      nearestStop && nearestStop.outcome === "deny"
        ? ` (and ${nearestStop.margin} short of being denied outright, at ${nearestStop.amount})`
        : "";
    if (cf.maxAllowAmount !== null && cf.maxAllowAmount < asked) {
      return `Held for a human. Would have settled unattended at any amount ≤ ${cf.maxAllowAmount} (it asked for ${asked})${tail}.`;
    }
    return `Held for a human — no smaller amount settles it unattended (${cf.categoricalBlockers.join(", ") || "policy requires review"})${tail}.`;
  }
  // deny
  if (cf.maxAllowAmount !== null && cf.maxAllowAmount < asked) {
    return `Denied. Would have settled unattended at any amount ≤ ${cf.maxAllowAmount} (it asked for ${asked}).`;
  }
  if (cf.maxNonDenyAmount !== null && cf.maxNonDenyAmount < asked) {
    return `Denied on amount — at ≤ ${cf.maxNonDenyAmount} it would instead be held for a human, not refused outright.`;
  }
  return `Denied — no amount clears it. Blocked on: ${cf.categoricalBlockers.join(", ") || "policy"}.`;
}

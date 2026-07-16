/**
 * @ramp/gate — reclassify.ts (policy what-if, replayed on real facts)
 *
 * "If we lowered the per-transaction cap to $300, what would that have done to the
 * payments we already saw?" This answers it by DETERMINISTIC REPLAY: take the exact
 * `Facts` a decision was made on, override only the policy KNOBS (caps, limits,
 * thresholds), and re-run the same kernel. The verdict falls out the same way it
 * did in production — because it is the same kernel on the same facts, minus the
 * one thing you changed.
 *
 * ============================================================================
 * WHAT MOVES AND WHAT DOES NOT — stated plainly, because a what-if that quietly
 * changed the wrong things would be worse than no what-if.
 * ============================================================================
 * Only the org POLICY CONFIG fields move: `per_txn_cap`, `daily_limit`,
 * `escalation_threshold`, `velocity_limit`. Everything else in the facts is left
 * EXACTLY as it was recorded — the amount, the vendor and its verification, the
 * category clearances, the daily-total-so-far and every budget's spent figure, the
 * attestation result. That is the correct semantics for the question "would this
 * policy have decided differently on the SAME requests": the world is held fixed
 * and only the rulebook's dials turn.
 *
 * Deliberately NOT overridable here: the per-budget limits inside `Facts.budgets`
 * (a category/vendor/window budget change is a different question — it needs the
 * budget table, not a scalar knob), and the categorical facts (vendor verification,
 * category approval, attestation) which are not policy dials at all. A caller that
 * needs those runs a fuller simulation against a modified ledger, not this.
 *
 * PURE: no I/O, no clock. Facts + overrides in, Facts / Decision out.
 */
import type { Facts, Decision, DecisionOutcome, PolicyKernel } from "@ramp/shared";

/** The policy dials this what-if can turn. All optional; omitted = unchanged. */
export interface PolicyOverrides {
  readonly per_txn_cap?: number;
  readonly daily_limit?: number;
  readonly escalation_threshold?: number;
  readonly velocity_limit?: number;
}

/** The policy-config keys of `Facts` that {@link applyPolicyOverrides} may touch. */
const OVERRIDABLE = [
  "per_txn_cap",
  "daily_limit",
  "escalation_threshold",
  "velocity_limit",
] as const satisfies ReadonlyArray<keyof Facts & keyof PolicyOverrides>;

/** True iff `o` sets at least one dial to a finite non-negative integer. */
export function hasOverrides(o: PolicyOverrides): boolean {
  return OVERRIDABLE.some((k) => o[k] !== undefined);
}

/**
 * Return a copy of `facts` with the given policy dials overridden. Only the four
 * overridable knobs are touched; every other fact is preserved byte-for-byte. An
 * override that is `undefined` leaves that dial unchanged.
 *
 * @throws if an override is present but not a finite, non-negative integer — money
 *   is whole units everywhere, and a garbage dial would produce a garbage what-if.
 */
export function applyPolicyOverrides(facts: Facts, o: PolicyOverrides): Facts {
  const next = { ...facts } as unknown as Record<string, unknown>;
  for (const k of OVERRIDABLE) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `applyPolicyOverrides: ${k} must be a finite, non-negative integer (got ${String(v)})`,
      );
    }
    next[k] = v;
  }
  return next as unknown as Facts;
}

/** One decision replayed under a hypothetical policy. */
export interface Reclassification {
  readonly before: DecisionOutcome;
  readonly after: DecisionOutcome;
  /** True iff the verdict changed under the override. */
  readonly changed: boolean;
  /** The kernel's full decision under the overridden facts (reasons + rules). */
  readonly afterDecision: Decision;
}

/**
 * Replay one decision under `overrides`. `beforeOutcome` is the outcome that was
 * ACTUALLY recorded (passed in rather than recomputed, so the "before" is the real
 * production verdict, not a fresh evaluation that might differ if the kernel has
 * since changed). The "after" is this kernel judging the override-adjusted facts.
 */
export function reclassify(
  facts: Facts,
  beforeOutcome: DecisionOutcome,
  overrides: PolicyOverrides,
  kernel: PolicyKernel,
): Reclassification {
  const afterDecision = kernel.evaluate(applyPolicyOverrides(facts, overrides));
  return {
    before: beforeOutcome,
    after: afterDecision.decision,
    changed: beforeOutcome !== afterDecision.decision,
    afterDecision,
  };
}

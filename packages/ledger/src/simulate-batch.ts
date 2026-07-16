/**
 * @ramp/ledger — simulate-batch.ts (pre-flight for a whole payment run)
 *
 * "Before I send this batch of payments, what will the gate do to it — and how
 * much money flows vs stops?" Answered with ZERO side effects: every item goes
 * through the same read-only {@link simulate} the single-request preview uses, and
 * every STOPPED item is annotated with the same kernel-confirmed counterfactual
 * `pnpm explain` produces. Nothing is recorded, nothing settles.
 *
 * ============================================================================
 * THE ONE THING THIS DOES NOT DO — AND SAYS SO OUT LOUD
 * ============================================================================
 * Each item is previewed against the ledger's CURRENT state. It does NOT compound
 * earlier items in the same batch: if an agent has $360 of daily headroom and the
 * batch contains three $200 payments for that agent, all three preview as "within
 * the daily limit" — because at the instant of preview, none of the others have
 * settled.
 *
 * We do not fake the compounding. Faking it would mean re-implementing, outside
 * the ledger, the exact accounting the fact source already owns (which items
 * settle, what each adds to daily totals AND every matching budget AND the
 * velocity count AND duplicate detection) — a second source of truth, which is
 * the precise thing this repo refuses to build. So instead we compute the honest,
 * checkable thing: for each agent, the SUM of amounts that previewed as `allow`,
 * against that agent's remaining daily headroom. When the sum exceeds the
 * headroom, the batch is flagged as OVERCOMMITTED for that agent — later payments
 * will deny once earlier ones settle — and the caller is told plainly. A preview
 * that quietly overstated what would clear would be worse than no preview.
 */
import type { SimulationInput, SimulationResult } from "./simulate.js";
import { simulate } from "./simulate.js";
import { explainDecision, type Explanation } from "@ramp/gate";
import type { PolicyKernel, Decision, DecisionOutcome } from "@ramp/shared";
import { getKernel } from "@ramp/gate";
import type { LedgerDb } from "./db.js";

/** One previewed payment: the kernel's verdict plus its counterfactual. */
export interface BatchItemResult {
  readonly input: SimulationInput;
  readonly result: SimulationResult;
  /** The same explanation `pnpm explain` produces — trivial for an `allow`. */
  readonly explanation: Explanation;
}

/** An agent whose previewed-allow amounts sum past their remaining daily headroom. */
export interface Overcommit {
  readonly agent: string;
  /** Sum of amounts that previewed as `allow` for this agent. */
  readonly allowedSum: number;
  /** The agent's remaining daily headroom at CURRENT ledger state. */
  readonly remainingToday: number;
  /** How many of this agent's allowed items are at risk once earlier ones settle. */
  readonly atRiskCount: number;
}

/** Roll-up of a batch preview. */
export interface BatchAggregate {
  readonly total: number;
  readonly counts: { readonly allow: number; readonly escalate: number; readonly deny: number };
  /** Money that would FLOW (sum of `allow` amounts) at current state. */
  readonly flowed: number;
  /** Money that would be HELD for a human (sum of `escalate` amounts). */
  readonly held: number;
  /** Money flatly DENIED (sum of `deny` amounts). */
  readonly denied: number;
  /**
   * Agents whose independent-preview allows sum past their daily headroom — i.e.
   * the preview's optimism about them does not survive compounding. Empty when
   * the batch is safe to send as previewed.
   */
  readonly overcommitted: readonly Overcommit[];
}

/** The full batch preview. */
export interface BatchSimulation {
  readonly items: readonly BatchItemResult[];
  readonly aggregate: BatchAggregate;
}

function toDecision(r: SimulationResult): Decision {
  return { decision: r.outcome, reasons: [...r.reasons], firedRules: [...r.firedRules] };
}

/**
 * Preview an entire batch of hypothetical spends against CURRENT ledger state,
 * with zero side effects. Each item is judged by the real kernel (via the
 * read-only {@link simulate}) and annotated with its counterfactual; the aggregate
 * reports money flow and flags per-agent overcommitment (see the file header).
 *
 * @throws only if {@link simulate} throws on a malformed amount — which drops that
 *   one item's evaluation; callers that prefer to skip bad rows should validate
 *   first. (The CLI validates and reports row errors rather than aborting.)
 */
export function simulateBatch(
  db: LedgerDb,
  inputs: readonly SimulationInput[],
  kernel: PolicyKernel = getKernel().kernel,
): BatchSimulation {
  const items: BatchItemResult[] = inputs.map((input) => {
    const result = simulate(db, input, kernel);
    const explanation = explainDecision(result.facts, toDecision(result), kernel);
    return { input, result, explanation };
  });

  const counts = { allow: 0, escalate: 0, deny: 0 };
  let flowed = 0;
  let held = 0;
  let denied = 0;

  // Per-agent: remaining daily headroom (from the resolved facts — same for every
  // item of an agent, since preview does not compound) and the sum of allow amounts.
  const perAgent = new Map<
    string,
    { remainingToday: number; allowedSum: number; atRiskCount: number }
  >();

  for (const it of items) {
    const outcome: DecisionOutcome = it.result.outcome;
    counts[outcome]++;
    const amt = it.result.facts.amount;
    if (outcome === "allow") flowed += amt;
    else if (outcome === "escalate") held += amt;
    else denied += amt;

    const agent = it.result.facts.requesting_agent;
    const remainingToday = Math.max(
      0,
      it.result.facts.daily_limit - it.result.facts.daily_total_so_far,
    );
    const slot = perAgent.get(agent) ?? { remainingToday, allowedSum: 0, atRiskCount: 0 };
    // remainingToday is identical across an agent's items; keep the first (min-safe).
    slot.remainingToday = remainingToday;
    if (outcome === "allow") {
      slot.allowedSum += amt;
      slot.atRiskCount++;
    }
    perAgent.set(agent, slot);
  }

  const overcommitted: Overcommit[] = [];
  for (const [agent, s] of perAgent) {
    if (s.allowedSum > s.remainingToday) {
      overcommitted.push({
        agent,
        allowedSum: s.allowedSum,
        remainingToday: s.remainingToday,
        atRiskCount: s.atRiskCount,
      });
    }
  }
  // Deterministic order (Map iteration is insertion order, but sort for stability
  // across callers that build inputs differently).
  overcommitted.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));

  return {
    items,
    aggregate: {
      total: items.length,
      counts,
      flowed,
      held,
      denied,
      overcommitted,
    },
  };
}

/**
 * @ramp/dashboard — per-agent rollups (the data behind an Agent Card)
 *
 * There is no `/agents` endpoint (see bridge.ts) — every number here is
 * derived, client-side, from the same `DecisionView[]` the Activity table
 * reads, and every count is a tally over the decisions actually passed in.
 *
 * SPEND IS DERIVED, NEVER COPIED. An earlier version of this file took the
 * agent's daily total straight off the most recent decision's `Facts`
 * snapshot, on the rationale that recomputing would be "a second, drifting
 * copy of numbers the kernel already settled". That rationale is only valid
 * for point-in-time CONFIG (per-txn cap, daily limit, clearances) — which is
 * still copied verbatim below. It is invalid for a running AGGREGATE: a facts
 * snapshot records the total BEFORE its own decision, so it is stale by
 * construction, and it counted money that never moved. Today's spend is now
 * summed from the transactions themselves via lib/spend.ts — the same
 * predicate the vendor/category rollups and the ledger DAL use.
 */
import type { DecisionView, Facts } from "./types.js";
import { agentLabel } from "./identity.js";
import { isSettledSpend, settledSpendOn, todayKey } from "./spend.js";

export interface OutcomeCounts {
  allow: number;
  deny: number;
  escalate: number;
  error: number;
}

export interface VendorSpend {
  vendorId: string;
  amount: number;
}

export interface AgentSummary {
  agentId: string;
  label: string;
  decisionCount: number;
  outcomeCounts: OutcomeCounts;
  /**
   * Sum of `amount` for allow decisions with a settled sandbox receipt, over
   * the decisions passed in. A recorded-WINDOW total (bounded by however many
   * decisions the caller fetched), not an all-time figure — never presented as
   * more complete than it is.
   */
  settledSpend: number;
  /**
   * This agent's spend on the current UTC calendar day, DERIVED by summing
   * `amount` over its allow+settled decisions dated today (lib/spend.ts) —
   * never read from `Facts.daily_total_so_far`, which is a stale pre-decision
   * snapshot, not a current aggregate.
   *
   * Always a number: `0` means "nothing settled today", which is a true
   * statement about the window, not a fabricated figure. Like `settledSpend`
   * it is bounded by however many decisions the caller fetched.
   */
  dailyTotalSoFar: number;
  /** Org per-transaction cap, as observed on the most recent decision with facts. Policy config, not an aggregate. */
  perTxnCap: number | null;
  /** Org daily limit, as observed on the most recent decision with facts. Policy config, not an aggregate. */
  dailyLimit: number | null;
  /** Union of every category this agent has been cleared for, across all observed facts. */
  clearedCategories: string[];
  /** Count of decisions whose proof independently re-verified (reason "ok"). */
  proofValidCount: number;
  /** Corrupt records, tampered/corrupt proofs, or failed settlements. */
  flaggedCount: number;
  /**
   * Average REQUESTED amount across all decisions in the window (any outcome).
   * Deliberately not a spend figure — it answers "how big is a typical ask",
   * so denied/held requests belong in it. Present it as "Avg request", never
   * as spend.
   */
  avgAmount: number;
  /**
   * The vendor this agent has sent the most SETTLED spend to, in-window.
   * `null` when nothing has settled. Uses the same predicate as every other
   * spend figure, so the card's "Top: <vendor>" can never disagree with the
   * settled-spend vendor list rendered beside it.
   */
  topVendor: VendorSpend | null;
  vendorsUsed: number;
  lastActivityTs: string | null;
}

function isFlagged(d: DecisionView): boolean {
  const reason = d.proofVerification.reason;
  return (
    d.corrupt === true ||
    reason === "mismatch" ||
    reason === "corrupt" ||
    d.execution?.status === "failed"
  );
}

/**
 * Group a decisions feed into one summary per agent. Pure; no I/O, no fetch.
 *
 * `now` fixes which UTC day counts as "today" for `dailyTotalSoFar`. It is
 * injectable so the rule is testable without a clock; production callers omit
 * it and get the real current day.
 */
export function summarizeAgents(
  decisions: readonly DecisionView[],
  now: Date = new Date(),
): AgentSummary[] {
  const today = todayKey(now);
  const byAgent = new Map<string, DecisionView[]>();
  for (const d of decisions) {
    const list = byAgent.get(d.agentId) ?? [];
    list.push(d);
    byAgent.set(d.agentId, list);
  }

  const summaries: AgentSummary[] = [];

  for (const [agentId, rows] of byAgent) {
    // Newest first — the bridge already serves this order, but a caller may
    // have merged pages out of order, so don't assume it.
    const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

    const outcomeCounts: OutcomeCounts = { allow: 0, deny: 0, escalate: 0, error: 0 };
    let settledSpend = 0;
    let proofValidCount = 0;
    let flaggedCount = 0;
    let amountSum = 0;
    const clearedCategories = new Set<string>();
    const vendorSpend = new Map<string, number>();
    const vendorsSeen = new Set<string>();
    let latestFacts: Facts | null = null;

    for (const d of sorted) {
      if (d.outcome === "allow") outcomeCounts.allow += 1;
      else if (d.outcome === "deny") outcomeCounts.deny += 1;
      else if (d.outcome === "escalate") outcomeCounts.escalate += 1;
      if (d.status === "error") outcomeCounts.error += 1;

      if (isSettledSpend(d)) {
        settledSpend += d.amount;
      }
      if (d.proofVerification.reason === "ok") proofValidCount += 1;
      if (isFlagged(d)) flaggedCount += 1;
      amountSum += d.amount;

      vendorsSeen.add(d.vendorId);
      // Settled only: an allowed-but-unexecuted request is not spend, so it
      // must not be able to crown a "top vendor" this agent never paid.
      if (isSettledSpend(d)) {
        vendorSpend.set(d.vendorId, (vendorSpend.get(d.vendorId) ?? 0) + d.amount);
      }

      if (d.facts && latestFacts === null) {
        // `sorted` is newest-first, so the first facts we encounter are latest.
        for (const c of d.facts.agent_cleared_categories) clearedCategories.add(c);
        latestFacts = d.facts;
      } else if (d.facts) {
        for (const c of d.facts.agent_cleared_categories) clearedCategories.add(c);
      }
    }

    let topVendor: VendorSpend | null = null;
    for (const [vendorId, amount] of vendorSpend) {
      if (topVendor === null || amount > topVendor.amount) topVendor = { vendorId, amount };
    }

    summaries.push({
      agentId,
      label: agentLabel(agentId),
      decisionCount: sorted.length,
      outcomeCounts,
      settledSpend,
      // DERIVED from this agent's transactions — deliberately NOT
      // `latestFacts.daily_total_so_far` (see the module header).
      dailyTotalSoFar: settledSpendOn(sorted, today),
      perTxnCap: latestFacts?.per_txn_cap ?? null,
      dailyLimit: latestFacts?.daily_limit ?? null,
      clearedCategories: [...clearedCategories].sort(),
      proofValidCount,
      flaggedCount,
      avgAmount: sorted.length > 0 ? amountSum / sorted.length : 0,
      topVendor,
      vendorsUsed: vendorsSeen.size,
      lastActivityTs: sorted[0]?.ts ?? null,
    });
  }

  // Biggest daily spenders first (the most business-relevant ordering for a
  // fleet view); ties broken by id so the order is deterministic. Now ranks on
  // a derived total, so the fleet can no longer be ordered by fabricated money.
  summaries.sort((a, b) => {
    const diff = b.dailyTotalSoFar - a.dailyTotalSoFar;
    return diff !== 0 ? diff : a.agentId.localeCompare(b.agentId);
  });

  return summaries;
}

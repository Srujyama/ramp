/**
 * @ramp/dashboard — per-agent rollups (the data behind an Agent Card)
 *
 * There is no `/agents` endpoint (see bridge.ts) — every number here is
 * derived, client-side, from the same `DecisionView[]` the Activity table
 * reads. Nothing is invented: caps/clearances/daily-usage are copied verbatim
 * from the most recent decision's `Facts` for that agent (never recomputed —
 * recomputation would be a second, drifting copy of numbers the kernel already
 * settled), and every count is a tally over the decisions actually passed in.
 */
import type { DecisionView, Facts } from "./types.js";
import { agentLabel } from "./identity.js";

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
   * The authoritative daily total as of this agent's most recent decision with
   * facts — copied verbatim from `Facts.daily_total_so_far`, never recomputed
   * client-side. `null` when no decision in the window carried facts.
   */
  dailyTotalSoFar: number | null;
  /** Org per-transaction cap, as observed on the most recent decision with facts. */
  perTxnCap: number | null;
  /** Org daily limit, as observed on the most recent decision with facts. */
  dailyLimit: number | null;
  /** Union of every category this agent has been cleared for, across all observed facts. */
  clearedCategories: string[];
  /** Count of decisions whose proof independently re-verified (reason "ok"). */
  proofValidCount: number;
  /** Corrupt records, tampered/corrupt proofs, or failed settlements. */
  flaggedCount: number;
  /** Average request amount across all decisions in the window (any outcome). */
  avgAmount: number;
  /** The vendor this agent has sent the most allowed spend to, in-window. */
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

/** Group a decisions feed into one summary per agent. Pure; no I/O, no fetch. */
export function summarizeAgents(decisions: readonly DecisionView[]): AgentSummary[] {
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

      if (d.outcome === "allow" && d.execution?.status === "settled") {
        settledSpend += d.amount;
      }
      if (d.proofVerification.reason === "ok") proofValidCount += 1;
      if (isFlagged(d)) flaggedCount += 1;
      amountSum += d.amount;

      vendorsSeen.add(d.vendorId);
      if (d.outcome === "allow") {
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
      dailyTotalSoFar: latestFacts?.daily_total_so_far ?? null,
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
  // fleet view); ties broken by id so the order is deterministic.
  summaries.sort((a, b) => {
    const diff = (b.dailyTotalSoFar ?? 0) - (a.dailyTotalSoFar ?? 0);
    return diff !== 0 ? diff : a.agentId.localeCompare(b.agentId);
  });

  return summaries;
}

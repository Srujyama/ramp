/**
 * @ramp/dashboard — vendor / category / daily-spend rollups
 *
 * Same rule as agents.ts: no dedicated endpoint exists for any of these views,
 * so every figure is tallied client-side from the `DecisionView[]` the bridge
 * already serves. Vendor identity (verified, risk tier) is copied verbatim
 * from the most recent `Facts` that named that vendor — never re-derived or
 * guessed — with only the display label/domain coming from the static
 * identity map (lib/identity.ts), which carries no security meaning.
 *
 * Every spend figure below uses `isSettledSpend` from lib/spend.ts. The rule
 * used to be spelled out inline in each rollup; it is imported now so that the
 * definition of "money that moved" can never drift between two copies.
 */
import type { DecisionView, Facts } from "./types.js";
import type { OutcomeCounts } from "./agents.js";
import { vendorLabel, vendorDomain } from "./identity.js";
import { isSettledSpend, dateKey } from "./spend.js";

/** The org-wide policy config in force, from the most recent decision carrying facts. */
export function latestFacts(decisions: readonly DecisionView[]): Facts | null {
  for (const d of decisions) {
    if (d.facts) return d.facts;
  }
  return null;
}

function emptyOutcomeCounts(): OutcomeCounts {
  return { allow: 0, deny: 0, escalate: 0, error: 0 };
}

function tallyOutcome(counts: OutcomeCounts, d: DecisionView): void {
  if (d.outcome === "allow") counts.allow += 1;
  else if (d.outcome === "deny") counts.deny += 1;
  else if (d.outcome === "escalate") counts.escalate += 1;
  if (d.status === "error") counts.error += 1;
}

// --- vendors -------------------------------------------------------------

export interface VendorSummary {
  vendorId: string;
  label: string;
  domain: string | null;
  /** From the most recent decision's Facts that named this vendor; null if never observed with facts. */
  verified: boolean | null;
  riskTier: string | null;
  decisionCount: number;
  settledSpend: number;
  outcomeCounts: OutcomeCounts;
}

export function summarizeVendors(decisions: readonly DecisionView[]): VendorSummary[] {
  const byVendor = new Map<string, DecisionView[]>();
  for (const d of decisions) {
    const list = byVendor.get(d.vendorId) ?? [];
    list.push(d);
    byVendor.set(d.vendorId, list);
  }

  const summaries: VendorSummary[] = [];
  for (const [vendorId, rows] of byVendor) {
    const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const outcomeCounts = emptyOutcomeCounts();
    let settledSpend = 0;
    let verified: boolean | null = null;
    let riskTier: string | null = null;
    let sawFacts = false;

    for (const d of sorted) {
      tallyOutcome(outcomeCounts, d);
      if (isSettledSpend(d)) settledSpend += d.amount;
      if (!sawFacts && d.facts) {
        verified = d.facts.vendor_verified;
        riskTier = d.facts.vendor_risk_tier;
        sawFacts = true;
      }
    }

    summaries.push({
      vendorId,
      label: vendorLabel(vendorId),
      domain: vendorDomain(vendorId),
      verified,
      riskTier,
      decisionCount: sorted.length,
      settledSpend,
      outcomeCounts,
    });
  }

  summaries.sort((a, b) => b.settledSpend - a.settledSpend || a.vendorId.localeCompare(b.vendorId));
  return summaries;
}

// --- categories ------------------------------------------------------------

export interface CategorySummary {
  category: string;
  /** From the most recent decision's Facts naming this category; null if never observed with facts. */
  approved: boolean | null;
  decisionCount: number;
  settledSpend: number;
  outcomeCounts: OutcomeCounts;
}

export function summarizeCategories(decisions: readonly DecisionView[]): CategorySummary[] {
  const byCategory = new Map<string, DecisionView[]>();
  for (const d of decisions) {
    const list = byCategory.get(d.category) ?? [];
    list.push(d);
    byCategory.set(d.category, list);
  }

  const summaries: CategorySummary[] = [];
  for (const [category, rows] of byCategory) {
    const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const outcomeCounts = emptyOutcomeCounts();
    let settledSpend = 0;
    let approved: boolean | null = null;
    let sawFacts = false;

    for (const d of sorted) {
      tallyOutcome(outcomeCounts, d);
      if (isSettledSpend(d)) settledSpend += d.amount;
      if (!sawFacts && d.facts) {
        approved = d.facts.approved_categories.includes(category);
        sawFacts = true;
      }
    }

    summaries.push({ category, approved, decisionCount: sorted.length, settledSpend, outcomeCounts });
  }

  summaries.sort((a, b) => b.settledSpend - a.settledSpend || a.category.localeCompare(b.category));
  return summaries;
}

// --- daily spend -------------------------------------------------------------

export interface DailySpendPoint {
  /** UTC calendar date, "YYYY-MM-DD". */
  date: string;
  settledSpend: number;
  allowed: number;
  denied: number;
  escalated: number;
}

/** One point per calendar day observed in the window, oldest first. */
export function dailySpend(decisions: readonly DecisionView[]): DailySpendPoint[] {
  const byDay = new Map<string, DailySpendPoint>();
  for (const d of decisions) {
    const key = dateKey(d.ts);
    const point = byDay.get(key) ?? { date: key, settledSpend: 0, allowed: 0, denied: 0, escalated: 0 };
    if (d.outcome === "allow") {
      point.allowed += 1;
      if (isSettledSpend(d)) point.settledSpend += d.amount;
    } else if (d.outcome === "deny") {
      point.denied += 1;
    } else if (d.outcome === "escalate") {
      point.escalated += 1;
    }
    byDay.set(key, point);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

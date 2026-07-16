/**
 * @ramp/dashboard — the single definition of "money that actually moved"
 *
 * Every spend figure in this app derives from the decision log the read-only
 * bridge serves, using ONE predicate defined here. This module exists because
 * the rule was previously re-implemented inline in several places, which let a
 * fabricated total (`Facts.daily_total_so_far`) masquerade as a current
 * aggregate on the Agent Card while the vendor rollups told the truth.
 *
 * The rule mirrors the ledger DAL verbatim (`packages/ledger/src/dal.ts`):
 *
 *     FROM decisions d JOIN decision_executions e ON e.decision_id = d.decision_id
 *     WHERE d.outcome = 'allow' AND e.status = 'settled' AND date(d.ts) = date('now')
 *
 * Anything else — denied, escalated/held, allowed-but-never-executed, or
 * allowed-then-failed — is money that did NOT move and contributes zero.
 *
 * WHAT MAY STILL COME FROM `Facts`: genuinely point-in-time policy CONFIG
 * (per-txn cap, daily limit, clearances, approved categories). Those are the
 * values the kernel evaluated against and are correct to copy verbatim.
 * A running AGGREGATE must never be read off a snapshot: a facts snapshot
 * records the total BEFORE its own decision, so it is stale by construction and
 * later settlements can never appear in it.
 */
import type { DecisionView } from "./types.js";

/**
 * The one and only test for "this decision moved money".
 *
 * An `allow` outcome alone is NOT spend — the payment still has to have
 * settled. `execution === null` means it was authorised but never executed;
 * `execution.status === "failed"` means the transfer did not complete.
 */
export function isSettledSpend(d: DecisionView): boolean {
  return d.outcome === "allow" && d.execution?.status === "settled";
}

/**
 * SQLite datetime ("2026-07-14 10:00:00", UTC) -> "2026-07-14". Never throws:
 * an unparseable timestamp falls back to its leading 10 chars so a malformed
 * row buckets somewhere deterministic instead of crashing a rollup.
 */
export function dateKey(ts: string): string {
  const d = new Date(ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10) || "unknown";
  return d.toISOString().slice(0, 10);
}

/**
 * The current UTC calendar day as "YYYY-MM-DD" — the same day boundary
 * SQLite's `date('now')` uses, so the dashboard and the ledger agree on when
 * "today" starts. Injectable for tests; never call with a local-time date.
 */
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Total settled spend across `decisions`, unbounded by date. */
export function settledSpendTotal(decisions: readonly DecisionView[]): number {
  let total = 0;
  for (const d of decisions) {
    if (isSettledSpend(d)) total += d.amount;
  }
  return total;
}

/**
 * Total settled spend on one UTC calendar day, derived from the decisions
 * passed in.
 *
 * Window caveat: this is bounded by however many decisions the caller fetched.
 * It is a true statement about the recorded window, never presented as more
 * complete than it is — and `0` is an honest answer (nothing settled today),
 * not a fabrication.
 */
export function settledSpendOn(decisions: readonly DecisionView[], day: string): number {
  let total = 0;
  for (const d of decisions) {
    if (isSettledSpend(d) && dateKey(d.ts) === day) total += d.amount;
  }
  return total;
}

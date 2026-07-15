/**
 * @ramp/dashboard — recent-activity selection (pure, tested)
 *
 * Selection logic for the Overview "Recent Activity" strip lives here, kept out
 * of the React component so it can be unit-tested with plain `node:test` (the
 * dashboard has no jsdom / react-testing-library). Nothing here fabricates data:
 * it only orders and trims the decisions the read-only bridge actually served.
 */
import type { DecisionView } from "./types.js";

/**
 * Parse a `DecisionView`'s SQLite datetime ("YYYY-MM-DD HH:MM:SS", UTC) to epoch
 * millis. Missing / non-string / unparseable timestamps sort as OLDEST so a
 * malformed row can never jump to the top of "most recent".
 */
function tsMillis(v: DecisionView): number {
  const ts = (v as { ts?: unknown } | null | undefined)?.ts;
  if (typeof ts !== "string") return -Infinity;
  const t = new Date(ts.replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * The `n` most recent decisions, newest first.
 *
 * Ordering guarantees:
 *  - descending by `ts` (newest first);
 *  - STABLE for equal timestamps — rows with the same `ts` keep their input
 *    order (the bridge already serves newest-first, so ties stay as served);
 *  - defensive — a missing / malformed `ts` is treated as oldest and never
 *    throws;
 *  - never mutates the input (operates on a copy);
 *  - returns at most `n` items (empty array in, empty array out; `n <= 0` → []).
 */
export function recentDecisions(
  views: readonly DecisionView[],
  n = 5,
): DecisionView[] {
  if (!Array.isArray(views)) return [];
  if (n <= 0) return [];
  const sorted = views.slice().sort((a, b) => {
    const ta = tsMillis(a);
    const tb = tsMillis(b);
    // Equal (incl. both -Infinity) → 0 keeps input order: Array.sort is stable.
    if (ta === tb) return 0;
    return tb - ta;
  });
  return sorted.slice(0, n);
}

/**
 * Honest "Updated Xs ago" label for a value fetched at `when`, evaluated at
 * `now`. There is no ticking clock behind it — the caller recomputes on render,
 * so the label only ever reflects a real elapsed interval.
 */
export function lastUpdatedLabel(when: Date, now: Date): string {
  const secs = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000));
  if (secs < 60) return `Updated ${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `Updated ${days}d ago`;
}

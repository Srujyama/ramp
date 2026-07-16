import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";
import { fetchDecisions } from "./bridge.js";
import { useAsync, type AsyncState } from "./useAsync.js";
import type { DecisionView } from "./types.js";

/**
 * The Dashboard/Agents/Vendors pages all derive their widgets from this one
 * decision window (see agents.ts/rollups.ts) — fetching it once here means
 * opening five widgets doesn't fire five identical requests against the bridge.
 * Activity keeps its OWN fetch (server-side filters + cursor pagination need a
 * live query, not this shared window).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PAGES THE WHOLE LOG INSTEAD OF TAKING THE NEWEST 200
 * ---------------------------------------------------------------------------
 * It used to fetch exactly 200 rows, once. Every page then filtered that slice per
 * agent and per vendor and presented the result as that entity's totals: the agent
 * card read "82 decisions / $11,543 settled" for an agent whose ledger says 347 and
 * $50,492. Roughly a 4x under-report, with nothing in the label admitting a window
 * existed at all.
 *
 * The slice being GLOBAL is what makes it indefensible rather than merely coarse.
 * "Newest 200 across all agents" means one agent's lifetime spend FALLS when a
 * DIFFERENT agent gets busy and pushes its rows out. That is not a stale number or
 * an approximate one; it is a number about agent_47 that moves when agent_12 buys
 * staplers. No caption fixes it, because there is no honest sentence that describes
 * it.
 *
 * So the window is the log. Every per-entity aggregate is a real total now, and the
 * "in window" captions elsewhere are true because the window is everything.
 *
 * CAP + TRUNCATION. `MAX_DECISIONS` bounds what a browser will hold. If the log ever
 * exceeds it we stop and SAY so. The previous version computed `truncated` too, and
 * no caller ever read it — which is exactly how a bounded window passes for a
 * complete one: the honest signal existed and was dropped on the floor.
 */

/** The bridge clamps any single request to MAX_LIMIT (200), so the log is walked by cursor. */
const PAGE_SIZE = 200;

/**
 * Hard ceiling on rows held client-side. Sized well above the demo ledger (~850) and
 * low enough that a runaway log degrades honestly instead of hanging the tab. Hitting
 * it sets `truncated`, which the pages surface rather than swallow.
 */
const MAX_DECISIONS = 5000;

export type DecisionsWindow = AsyncState<{ decisions: DecisionView[]; truncated: boolean }> & {
  reload: () => void;
};

const Ctx = createContext<DecisionsWindow | null>(null);

export function DecisionsWindowProvider({ children }: { children: ReactNode }): JSX.Element {
  const state = useAsync(async (signal) => {
    const decisions: DecisionView[] = [];
    let cursor: string | undefined;
    let truncated = false;

    // Walk newest-first until the log is exhausted or the cap is hit. An absent
    // `nextCursor` is the bridge's own end-of-list signal, so a short final page is
    // never mistaken for more data (or the reverse).
    for (;;) {
      const res = await fetchDecisions({ limit: PAGE_SIZE, cursor }, signal);
      decisions.push(...res.decisions);
      cursor = res.nextCursor;
      if (cursor === undefined) break;
      if (decisions.length >= MAX_DECISIONS) {
        // More exists and we are choosing not to read it. Say so, rather than let
        // the pages present a prefix as the whole.
        truncated = true;
        break;
      }
    }

    return { decisions, truncated };
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useDecisionsWindow(): DecisionsWindow {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDecisionsWindow must be used inside DecisionsWindowProvider");
  return ctx;
}

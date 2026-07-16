import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";
import { fetchDecisions } from "./bridge.js";
import { useAsync, type AsyncState } from "./useAsync.js";
import type { DecisionView } from "./types.js";

/**
 * The Dashboard/Agents/Vendors pages all derive their widgets from the same
 * bounded recent-decisions window (see agents.ts/rollups.ts) — fetching it
 * once here means opening five widgets doesn't fire five identical requests
 * against the bridge. Activity keeps its OWN fetch (server-side filters +
 * cursor pagination need a live query, not this fixed window).
 */
const WINDOW_SIZE = 200;

export type DecisionsWindow = AsyncState<{ decisions: DecisionView[]; truncated: boolean }> & {
  reload: () => void;
};

const Ctx = createContext<DecisionsWindow | null>(null);

export function DecisionsWindowProvider({ children }: { children: ReactNode }): JSX.Element {
  const state = useAsync(async (signal) => {
    const res = await fetchDecisions({ limit: WINDOW_SIZE }, signal);
    return { decisions: res.decisions, truncated: res.nextCursor !== undefined };
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useDecisionsWindow(): DecisionsWindow {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDecisionsWindow must be used inside DecisionsWindowProvider");
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { fetchDecisions, BRIDGE_URL } from "./bridge.js";
import type { AsyncState } from "./useAsync.js";
import type { DecisionView } from "./types.js";

/**
 * The Dashboard/Agents/Vendors pages all derive their widgets from this one
 * decision window — fetching it once here means opening five widgets doesn't fire
 * five identical requests against the bridge.
 *
 * ---------------------------------------------------------------------------
 * LIVE, WITHOUT FLASHING
 * ---------------------------------------------------------------------------
 * The window is the whole log (see the earlier note preserved below on WHY not
 * "newest 200"). On top of the initial walk, it subscribes to the bridge's
 * read-only `GET /events` Server-Sent-Events tail and PREPENDS each new decision
 * as it lands — so a payment made through the gate appears here within a second,
 * with no manual reload and no skeleton flash (we mutate the list in place rather
 * than re-entering "loading"). SSE is a GET; the dashboard gains real-time reads
 * without the bridge ever gaining a write. If `EventSource` is unavailable or the
 * stream errors, it falls back to a periodic re-fetch so the page still refreshes.
 *
 * WHY THE WINDOW IS THE WHOLE LOG (preserved): a global "newest 200" made an
 * agent's lifetime total move when a DIFFERENT agent got busy — a number about
 * agent_47 that changed when agent_12 bought staplers. No caption fixes that. So
 * the window is everything; every per-entity aggregate is a real total.
 *
 * CAP + TRUNCATION. `MAX_DECISIONS` bounds what a browser holds; hitting it sets
 * `truncated`, which the pages surface rather than swallow.
 */

/** The bridge clamps any single request to MAX_LIMIT (200), so the log is walked by cursor. */
const PAGE_SIZE = 200;

/** Hard ceiling on rows held client-side (degrade honestly, never hang the tab). */
const MAX_DECISIONS = 5000;

/** Fallback re-fetch cadence when SSE is unavailable. */
const POLL_MS = 5000;

export type DecisionsWindow = AsyncState<{ decisions: DecisionView[]; truncated: boolean }> & {
  reload: () => void;
  /** True while the live SSE tail is connected; false when falling back to polling. */
  live: boolean;
};

const Ctx = createContext<DecisionsWindow | null>(null);

/** Walk the whole log newest-first (cursor paginated), capped at MAX_DECISIONS. */
async function fetchWindow(signal: AbortSignal): Promise<{ decisions: DecisionView[]; truncated: boolean }> {
  const decisions: DecisionView[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const res = await fetchDecisions({ limit: PAGE_SIZE, cursor }, signal);
    decisions.push(...res.decisions);
    cursor = res.nextCursor;
    if (cursor === undefined) break;
    if (decisions.length >= MAX_DECISIONS) {
      truncated = true;
      break;
    }
  }
  return { decisions, truncated };
}

/** Light structural guard for an SSE decision payload. */
function isDecisionView(v: unknown): v is DecisionView {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.decisionId === "string" && typeof d.status === "string" && Array.isArray(d.firedRules);
}

type State =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: { decisions: DecisionView[]; truncated: boolean } };

export function DecisionsWindowProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // Ids already held, so an SSE row that overlaps the initial fetch isn't doubled.
  const seen = useRef<Set<string>>(new Set());

  // Initial (and reload) full-window fetch.
  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    fetchWindow(ac.signal).then(
      (data) => {
        if (ac.signal.aborted) return;
        seen.current = new Set(data.decisions.map((d) => d.decisionId));
        setState({ status: "success", data });
      },
      (error) => {
        if (ac.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({ status: "error", error });
      },
    );
    return () => ac.abort();
  }, [nonce]);

  // Live tail: SSE prepend, with a polling fallback.
  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const prepend = (view: DecisionView): void => {
      if (seen.current.has(view.decisionId)) return;
      seen.current.add(view.decisionId);
      setState((prev) =>
        prev.status === "success"
          ? { status: "success", data: { decisions: [view, ...prev.data.decisions], truncated: prev.data.truncated } }
          : prev,
      );
    };

    const startPolling = (): void => {
      if (pollTimer !== null) return;
      setLive(false);
      pollTimer = setInterval(() => setNonce((n) => n + 1), POLL_MS);
    };

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      try {
        es = new EventSource(`${BRIDGE_URL}/events`);
        es.addEventListener("open", () => {
          if (!cancelled) setLive(true);
        });
        es.addEventListener("decision", (ev) => {
          try {
            const data: unknown = JSON.parse((ev as MessageEvent).data);
            if (isDecisionView(data)) prepend(data);
          } catch {
            /* ignore a malformed frame */
          }
        });
        es.addEventListener("error", () => {
          // EventSource auto-reconnects; we only flip the indicator. If it never
          // recovers the periodic reload below still refreshes the page.
          if (!cancelled) setLive(false);
        });
      } catch {
        startPolling();
      }
    }

    return () => {
      cancelled = true;
      if (es) es.close();
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }, []);

  const value: DecisionsWindow = { ...state, reload, live };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDecisionsWindow(): DecisionsWindow {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDecisionsWindow must be used inside DecisionsWindowProvider");
  return ctx;
}

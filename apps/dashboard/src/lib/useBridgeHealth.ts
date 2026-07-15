/**
 * @ramp/dashboard — bridge health
 *
 * One cheap probe (`/decisions?limit=1`) so the header can honestly show whether
 * the read-only audit bridge is reachable. `bump()` re-probes (e.g. after a
 * retry elsewhere). Never throws; maps any failure to "down".
 */
import { useCallback, useEffect, useState } from "react";
import { fetchDecisions } from "./bridge.js";

export type Health = "wait" | "live" | "down";

export function useBridgeHealth(): { health: Health; bump: () => void } {
  const [health, setHealth] = useState<Health>("wait");
  const [nonce, setNonce] = useState(0);
  const bump = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setHealth("wait");
    fetchDecisions({ limit: 1 }, ac.signal).then(
      () => {
        if (!ac.signal.aborted) setHealth("live");
      },
      (err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!ac.signal.aborted) setHealth("down");
      },
    );
    return () => ac.abort();
  }, [nonce]);

  return { health, bump };
}

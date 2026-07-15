/**
 * @ramp/dashboard — useAsync
 *
 * Minimal async-data hook: loading → success | error, with abort on unmount and
 * a `reload()` for retry. No data-fetching library — a few lines cover it.
 */
import { useEffect, useState, useCallback } from "react";

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: T };

export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    fn(ac.signal).then(
      (data) => {
        if (!ac.signal.aborted) setState({ status: "success", data });
      },
      (error) => {
        if (ac.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ status: "error", error });
      },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload };
}

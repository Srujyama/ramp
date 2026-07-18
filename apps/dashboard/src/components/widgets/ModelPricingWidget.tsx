import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Card, CardContent, CardHeader } from "../ui/card.js";
import { StateCard } from "../ui/state-card.js";
import { Skeleton } from "../ui/skeleton.js";
import { Badge } from "../ui/badge.js";
import { fetchPricing, type ModelPrice, type PricingResponse, ControlPlaneError, CONTROL_PLANE_URL } from "../../lib/controlPlane.js";

type Load =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: PricingResponse };

const PROVIDER: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

function sourceBadge(source: ModelPrice["source"]): JSX.Element {
  if (source === "live") return <Badge tone="accent">Live</Badge>;
  if (source === "cached") return <Badge tone="neutral">Cached</Badge>;
  return <Badge tone="warn">Fallback</Badge>;
}

function relTimeISO(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Reference-only model pricing: attempts a live fetch (control plane's
 * `GET /pricing`, itself live-with-fallback — see apps/control-plane/src/pricing.ts),
 * degrading honestly to the labeled static-fallback table it already carries.
 * Never enters a policy decision.
 */
export function ModelPricingWidget(): JSX.Element {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    fetchPricing(ac.signal)
      .then((data) => setLoad({ status: "success", data }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoad({ status: "error", error });
      });
    return () => ac.abort();
  }, []);

  const now = new Date();

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="font-display text-[15px] font-semibold text-ink">Model pricing</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">Reference only, USD per 1M tokens</p>
        </div>
        {load.status === "success" && load.data.refreshedAt ? (
          <span className="shrink-0 text-[11px] text-ink-faint">{relTimeISO(load.data.refreshedAt, now)}</span>
        ) : null}
      </CardHeader>
      <CardContent>
        {load.status === "loading" ? (
          <Skeleton className="h-40 w-full" />
        ) : load.status === "error" ? (
          <StateCard icon="offline" title="Control plane unreachable">
            {load.error instanceof ControlPlaneError && load.error.kind === "unavailable" ? (
              <>
                Start it with <code className="rounded-[--radius-xs] bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code>{" "}
                (<span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
              </>
            ) : (
              <>{(load.error as Error)?.message ?? "Unknown error."}</>
            )}
          </StateCard>
        ) : load.data.prices.length === 0 ? (
          <StateCard icon="warn" title="No pricing loaded yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-ink-faint">
                  <th className="pb-2 pr-2 font-medium">Model</th>
                  <th className="pb-2 pr-2 text-right font-medium">In</th>
                  <th className="pb-2 pr-2 text-right font-medium">Out</th>
                  <th className="pb-2 text-right font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {load.data.prices.map((m) => (
                  <tr key={`${m.provider}:${m.model}`} className="border-t border-line">
                    <td className="py-2 pr-2">
                      <div className="font-mono text-[12px] text-ink">{m.model}</div>
                      <div className="text-[10.5px] text-ink-faint">{PROVIDER[m.provider] ?? m.provider}</div>
                    </td>
                    <td className="tabular py-2 pr-2 text-right text-ink">
                      {m.currency === "USD" ? "$" : ""}
                      {m.inputPrice}
                    </td>
                    <td className="tabular py-2 pr-2 text-right text-ink">
                      {m.currency === "USD" ? "$" : ""}
                      {m.outputPrice}
                    </td>
                    <td className="py-2 text-right">{sourceBadge(m.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ModelPricingWidget;

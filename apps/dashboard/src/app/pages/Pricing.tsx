import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Coins, RefreshCw, TriangleAlert } from "lucide-react";
import {
  fetchPricing,
  type ModelPrice,
  type PricingResponse,
  ControlPlaneError,
  CONTROL_PLANE_URL,
} from "../../lib/controlPlane.js";
import { Card, CardContent } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { StateCard } from "../../components/ui/state-card.js";
import { Skeleton } from "../../components/ui/skeleton.js";

type Load =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: PricingResponse };

/** Provider display labels + tone. */
const PROVIDER: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

function sourceBadge(source: ModelPrice["source"]): JSX.Element {
  if (source === "live") return <Badge tone="accent">live</Badge>;
  if (source === "cached") return <Badge tone="neutral">cached</Badge>;
  return <Badge tone="warn">static fallback</Badge>;
}

/** Relative time from an ISO instant (the control plane stamps fetched_at as ISO). */
function relTimeISO(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function groupByProvider(prices: readonly ModelPrice[]): [string, ModelPrice[]][] {
  const map = new Map<string, ModelPrice[]>();
  for (const p of prices) {
    const arr = map.get(p.provider) ?? [];
    arr.push(p);
    map.set(p.provider, arr);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function Pricing(): JSX.Element {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const refresh = () => {
    setLoad({ status: "loading" });
    const ac = new AbortController();
    fetchPricing(ac.signal)
      .then((data) => setLoad({ status: "success", data }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoad({ status: "error", error });
      });
    return () => ac.abort();
  };

  useEffect(() => {
    document.title = "Pricing · Provable Agent Spend";
    return refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Model pricing</h1>
        <p className="text-[13.5px] text-ink-muted">
          Live vendor token prices, for reference. <span className="font-medium text-ink">Reference data only</span> —
          prices never enter a policy decision and never touch the enforcement path.
        </p>
      </div>

      {/* The honesty note the token-accounting decision requires. */}
      <Card>
        <CardContent className="flex items-start gap-3 py-3.5">
          <Coins className="mt-0.5 size-4 shrink-0 text-ink-faint" />
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Per-transaction cost is an <span className="font-medium text-ink">estimate</span> (price × tokens): an MCP
            tool call carries only its arguments, so the agent's real token usage isn't observable to the gate. We show
            it clearly labeled — never as a fact, never on the fail-closed path.
          </p>
        </CardContent>
      </Card>

      {load.status === "loading" ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : load.status === "error" ? (
        <StateCard
          icon="offline"
          tone="error"
          title="The demo control plane isn't reachable"
          onRetry={refresh}
        >
          {load.error instanceof ControlPlaneError && load.error.kind === "unavailable" ? (
            <>
              Start it with <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code>.
              It serves this reference data at <span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span> and is a
              separate demo-only process from the read-only audit bridge.
            </>
          ) : (
            <>{(load.error as Error)?.message ?? "Unknown error."}</>
          )}
        </StateCard>
      ) : load.data.prices.length === 0 ? (
        <StateCard icon="warn" title="No pricing loaded yet">
          The control plane is up but hasn't loaded prices. It seeds a static fallback on start, so this usually means a
          fresh <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm db:reset</code> is needed.
        </StateCard>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[12px] text-ink-faint">
            <RefreshCw className="size-3.5" />
            <span>
              {load.data.count} model{load.data.count === 1 ? "" : "s"} ·{" "}
              {load.data.refreshedAt ? `updated ${relTimeISO(load.data.refreshedAt, now)}` : "freshness unknown"}
            </span>
            {load.data.prices.some((p) => p.source === "static-fallback") ? (
              <span className="inline-flex items-center gap-1 text-amber-ink">
                <TriangleAlert className="size-3" /> some prices are static fallback
              </span>
            ) : null}
          </div>

          {groupByProvider(load.data.prices).map(([provider, models]) => (
            <Card key={provider}>
              <CardContent className="p-0">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <h2 className="font-display text-[15px] font-semibold text-ink">
                    {PROVIDER[provider] ?? provider}
                  </h2>
                  <span className="text-[12px] text-ink-faint">USD per 1M tokens</span>
                </div>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
                      <th className="px-4 py-2 font-medium">Model</th>
                      <th className="px-4 py-2 text-right font-medium">Input</th>
                      <th className="px-4 py-2 text-right font-medium">Output</th>
                      <th className="px-4 py-2 text-right font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => (
                      <tr key={m.model} className="border-t border-line">
                        <td className="px-4 py-2.5 font-mono text-[12.5px] text-ink">{m.model}</td>
                        <td className="px-4 py-2.5 text-right tabular text-ink">
                          {m.currency === "USD" ? "$" : ""}
                          {m.inputPrice}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular text-ink">
                          {m.currency === "USD" ? "$" : ""}
                          {m.outputPrice}
                        </td>
                        <td className="px-4 py-2.5 text-right">{sourceBadge(m.source)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

export default Pricing;

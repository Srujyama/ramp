import { useEffect } from "react";
import type { JSX } from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { summarizeVendors } from "../../lib/rollups.js";
import { formatMoney } from "../../lib/format.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Badge } from "../../components/ui/badge.js";

function VerifiedMark({ verified }: { verified: boolean | null }): JSX.Element {
  if (verified === true) {
    return (
      <span className="flex items-center gap-1 text-[12px] font-medium text-lime-ink">
        <ShieldCheck className="size-3.5" /> Verified
      </span>
    );
  }
  if (verified === false) {
    return (
      <span className="flex items-center gap-1 text-[12px] font-medium text-flag-ink">
        <ShieldAlert className="size-3.5" /> Unverified
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[12px] text-ink-faint">
      <ShieldQuestion className="size-3.5" /> Unknown
    </span>
  );
}

const RISK_TONE: Record<string, "accent" | "warn" | "deny" | "neutral"> = {
  trusted: "accent",
  standard: "neutral",
  elevated: "warn",
  unknown: "deny",
};

export function Vendors(): JSX.Element {
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = "Vendors · Provable Agent Spend";
  }, []);

  const vendors = win.status === "success" ? summarizeVendors(win.data.decisions) : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Vendors</h1>
        <p className="text-[13.5px] text-ink-muted">
          Every vendor an agent has requested spend to. Registry status, risk tier, and real settled spend.
        </p>
      </div>

      {win.status === "loading" ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : win.status === "error" ? (
        <BridgeErrorState error={win.error} onRetry={win.reload} />
      ) : vendors.length === 0 ? (
        <StateCard icon="building" title="No vendor activity yet">
          Trigger a payment through the MCP <code>pay_vendor</code> tool and vendors appear here.
        </StateCard>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden">
            {vendors.map((v) => (
              <li key={v.vendorId} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-ink">{v.label}</div>
                    {v.domain ? <div className="font-mono text-[11px] text-ink-faint">{v.domain}</div> : null}
                  </div>
                  <span className="tabular shrink-0 text-[14px] font-semibold text-ink">
                    {formatMoney(v.settledSpend, "USD")}
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <VerifiedMark verified={v.verified} />
                  {v.riskTier ? <Badge tone={RISK_TONE[v.riskTier] ?? "neutral"}>{v.riskTier}</Badge> : null}
                </div>
                <div className="mt-2.5 flex gap-4 text-[12px] text-ink-faint">
                  <span>{v.decisionCount} decisions</span>
                  <span className="text-lime-ink">{v.outcomeCounts.allow} allowed</span>
                  <span className="text-flag-ink">{v.outcomeCounts.deny} denied</span>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2.5 font-medium">Vendor</th>
                    <th className="px-4 py-2.5 font-medium">Registry</th>
                    <th className="px-4 py-2.5 font-medium">Risk tier</th>
                    <th className="px-4 py-2.5 text-right font-medium">Decisions</th>
                    <th className="px-4 py-2.5 text-right font-medium">Allowed</th>
                    <th className="px-4 py-2.5 text-right font-medium">Denied</th>
                    <th className="px-4 py-2.5 text-right font-medium">Settled spend</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v) => (
                    <tr key={v.vendorId} className="border-b border-line last:border-0 hover:bg-surface-hover">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{v.label}</div>
                        {v.domain ? <div className="font-mono text-[11px] text-ink-faint">{v.domain}</div> : null}
                      </td>
                      <td className="px-4 py-3">
                        <VerifiedMark verified={v.verified} />
                      </td>
                      <td className="px-4 py-3">
                        {v.riskTier ? (
                          <Badge tone={RISK_TONE[v.riskTier] ?? "neutral"}>{v.riskTier}</Badge>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-ink">{v.decisionCount}</td>
                      <td className="tabular px-4 py-3 text-right text-lime-ink">{v.outcomeCounts.allow}</td>
                      <td className="tabular px-4 py-3 text-right text-flag-ink">{v.outcomeCounts.deny}</td>
                      <td className="tabular px-4 py-3 text-right font-semibold text-ink">
                        {formatMoney(v.settledSpend, "USD")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default Vendors;

import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ShieldCheck, ShieldAlert } from "lucide-react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { summarizeAgents } from "../../lib/agents.js";
import { summarizeVendors } from "../../lib/rollups.js";
import { recentDecisions } from "../../lib/activity.js";
import { agentLabel } from "../../lib/identity.js";
import { formatMoney, formatRelative, formatTimestamp, outcomeChip, verificationChip } from "../../lib/format.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card.js";
import { AgentCard } from "../../components/AgentCard.js";
import { StatusChip } from "../../components/StatusChip.js";

export function AgentDetail(): JSX.Element {
  const { agentId = "" } = useParams();
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = `${agentLabel(agentId)} · Provable Agent Spend`;
  }, [agentId]);

  const agentDecisions = useMemo(
    () => (win.status === "success" ? win.data.decisions.filter((d) => d.agentId === agentId) : []),
    [win, agentId],
  );
  const summary = useMemo(
    () => (win.status === "success" ? summarizeAgents(agentDecisions).find((a) => a.agentId === agentId) ?? null : null),
    [win, agentDecisions, agentId],
  );
  const vendors = useMemo(() => summarizeVendors(agentDecisions).slice(0, 6), [agentDecisions]);
  const recent = useMemo(() => recentDecisions(agentDecisions, 8), [agentDecisions]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <Link to="/app/agents" className="flex w-fit items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> All agent cards
      </Link>

      {win.status === "loading" ? (
        <Skeleton className="h-[280px] max-w-md" />
      ) : win.status === "error" ? (
        <BridgeErrorState error={win.error} onRetry={win.reload} />
      ) : summary === null ? (
        <StateCard icon="card" title="No activity for this agent yet">
          {agentLabel(agentId)} hasn't made a request in the recent decision window.
        </StateCard>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <AgentCard agent={summary} linked={false} className="lg:col-span-1" />

          <div className="flex flex-col gap-4 lg:col-span-2">
            <div className="grid grid-cols-3 gap-4">
              <Card>
                <CardContent className="p-4">
                  <div className="text-[11px] text-ink-faint">Decisions</div>
                  <div className="tabular text-[20px] font-semibold text-ink">{summary.decisionCount}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-[11px] text-ink-faint">Settled spend</div>
                  <div className="tabular text-[20px] font-semibold text-ink">
                    {formatMoney(summary.settledSpend, "USD")}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-[11px] text-ink-faint">Avg request</div>
                  <div className="tabular text-[20px] font-semibold text-ink">
                    {formatMoney(Math.round(summary.avgAmount), "USD")}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Vendors used</CardTitle>
                  <CardDescription>By this agent, settled spend</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {vendors.length === 0 ? (
                  <p className="text-[13px] text-ink-muted">No vendor spend yet.</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {vendors.map((v) => (
                      <li key={v.vendorId} className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          {v.verified === true ? (
                            <ShieldCheck className="size-4 shrink-0 text-lime" />
                          ) : v.verified === false ? (
                            <ShieldAlert className="size-4 shrink-0 text-chart-deny" />
                          ) : null}
                          <span className="truncate text-[13.5px] text-ink">{v.label}</span>
                        </div>
                        <span className="tabular shrink-0 text-[13.5px] font-semibold text-ink">
                          {formatMoney(v.settledSpend, "USD")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {win.status === "success" && agentDecisions.length > 0 ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>This agent's latest decisions</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col">
              {recent.map((v, i) => (
                <li key={v.decisionId} className={i > 0 ? "border-t border-line" : undefined}>
                  <Link to={`/app/activity/${encodeURIComponent(v.decisionId)}`} className="block py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="tabular text-[13.5px] font-semibold text-ink">
                        {formatMoney(v.amount, v.request?.currency ?? "USD")}
                      </span>
                      <span className="text-[11.5px] text-ink-faint" title={formatTimestamp(v.ts)}>
                        {formatRelative(v.ts, now)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <StatusChip chip={outcomeChip(v)} />
                      <StatusChip chip={verificationChip(v.proofVerification.reason)} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default AgentDetail;

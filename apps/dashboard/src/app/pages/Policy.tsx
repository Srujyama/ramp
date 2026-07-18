import { useEffect } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { formatMoney } from "../../lib/format.js";
import { agentLabel } from "../../lib/identity.js";
import { settledSpendOn, todayKey } from "../../lib/spend.js";
import type { DecisionView, Facts } from "../../lib/types.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Progress } from "../../components/ui/progress.js";

// --- org policy overview (derived from recorded facts, never hand-entered) --

interface PolicyModel {
  currency: string;
  perTxnCap: number;
  dailyLimit: number;
  spentToday: number;
  approvedCategories: string[];
  clearances: Array<{ agent: string; categories: string[] }>;
}

/**
 * Caps/clearances come from recorded facts (policy CONFIG — correct to copy
 * verbatim). `spentToday` does NOT: it is derived org-wide from the decision
 * log with the same allow+settled+today rule the ledger uses, because
 * `Facts.daily_total_so_far` is a per-decision snapshot taken BEFORE its own
 * decision, not a current org aggregate.
 */
function derivePolicy(decisions: DecisionView[], now: Date = new Date()): PolicyModel | null {
  const withFacts = decisions.filter((d): d is DecisionView & { facts: Facts } => d.facts !== null);
  if (withFacts.length === 0) return null;

  // Don't assume the caller preserved the bridge's newest-first order.
  const newestFirst = [...withFacts].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const latest = newestFirst[0]!.facts;
  const approved = new Set<string>();
  const clearanceMap = new Map<string, Set<string>>();

  for (const d of withFacts) {
    for (const c of d.facts.approved_categories) approved.add(c);
    const set = clearanceMap.get(d.agentId) ?? new Set<string>();
    for (const c of d.facts.agent_cleared_categories) set.add(c);
    clearanceMap.set(d.agentId, set);
  }

  return {
    currency: newestFirst[0]!.request?.currency ?? "USD",
    perTxnCap: latest.per_txn_cap,
    dailyLimit: latest.daily_limit,
    // Derived from every decision in the window, not just those with facts.
    spentToday: settledSpendOn(decisions, todayKey(now)),
    approvedCategories: [...approved].sort(),
    clearances: [...clearanceMap.entries()]
      .map(([agent, cats]) => ({ agent, categories: [...cats].sort() }))
      .sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

function PolicyOverview({ p }: { p: PolicyModel }): JSX.Element {
  const fill = p.dailyLimit > 0 ? Math.min(1, p.spentToday / p.dailyLimit) : 0;
  const over = p.spentToday > p.dailyLimit;

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-ink-faint">Per-transaction cap</div>
            <div className="tabular text-[19px] font-semibold text-ink">{formatMoney(p.perTxnCap, p.currency)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-ink-faint">Daily limit</div>
            <div className="tabular text-[19px] font-semibold text-ink">{formatMoney(p.dailyLimit, p.currency)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-ink-faint">Approved categories</div>
            <div className="text-[19px] font-semibold text-ink">{p.approvedCategories.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-ink-faint">Cleared agents</div>
            <div className="text-[19px] font-semibold text-ink">{p.clearances.length}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Spend vs. daily limit</CardTitle>
              <CardDescription>Settled spend today, summed from the decision log, against the org cap.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={fill} tone={over ? "flag" : "lime"} />
            <p className="mt-2.5 text-[13px] text-ink-muted">
              {formatMoney(p.spentToday, p.currency)} spent{over ? " (over limit)" : ""} of{" "}
              {formatMoney(p.dailyLimit, p.currency)}.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Approved categories</CardTitle>
              <CardDescription>The org-approved spend categories the policy engine checks against.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {p.approvedCategories.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {p.approvedCategories.map((c) => (
                  <span key={c} className="rounded-[--radius-xs] bg-surface-sunken px-2 py-1 text-[11.5px] capitalize text-ink-muted">
                    {c.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-muted">None observed yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Agent clearances</CardTitle>
            <CardDescription>Which categories each agent may spend in, sourced from the ledger, not model narration.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-4 font-medium">Agent</th>
                  <th className="py-2 font-medium">Cleared categories</th>
                </tr>
              </thead>
              <tbody>
                {p.clearances.map((c) => (
                  <tr key={c.agent} className="border-b border-line last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-ink">{agentLabel(c.agent)}</td>
                    <td className="py-2.5">
                      {c.categories.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {c.categories.map((cat) => (
                            <span key={cat} className="rounded-[--radius-xs] bg-surface-sunken px-2 py-1 text-[11.5px] capitalize text-ink-muted">
                              {cat.replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ink-faint">none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export function Policy(): JSX.Element {
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = "Policy · Provable Agent Spend";
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Policy</h1>
          <p className="text-[13.5px] text-ink-muted">The caps and clearances the deterministic policy engine enforces, derived from recorded facts.</p>
        </div>
        <Link to="/app/simulate" className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-lime-ink hover:underline">
          Test a purchase on Simulate <ArrowRight className="size-3.5" />
        </Link>
      </div>

      {win.status === "loading" ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-20 w-full" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      ) : win.status === "error" ? (
        <BridgeErrorState error={win.error} onRetry={win.reload} />
      ) : (
        (() => {
          const p = derivePolicy(win.data.decisions);
          return p ? (
            <PolicyOverview p={p} />
          ) : (
            <StateCard icon="shield" title="No policy facts yet">
              Policy limits and clearances appear here once decisions with authoritative facts are recorded.
              Trigger a <code>pay_vendor</code> call to populate them.
            </StateCard>
          );
        })()
      )}
    </div>
  );
}

export default Policy;

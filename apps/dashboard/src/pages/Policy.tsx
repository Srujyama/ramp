import type { CSSProperties, JSX } from "react";
import { useEffect } from "react";
import { fetchDecisions } from "../lib/bridge.js";
import { useAsync } from "../lib/useAsync.js";
import { formatMoney } from "../lib/format.js";
import type { DecisionView, Facts } from "../lib/types.js";
import StatTile from "../components/StatTile.js";
import { BridgeErrorState, StateCard, Skeleton } from "../components/ui.js";

/**
 * @ramp/dashboard — Policy
 *
 * The caps + clearances the kernel enforces. There is no separate policy-config
 * endpoint, so this is DERIVED from the authoritative facts recorded on real
 * decisions — i.e. exactly what the kernel evaluated against, not a hand-entered
 * mirror. Empty until decisions with facts exist; never fabricated.
 */

interface PolicyModel {
  currency: string;
  perTxnCap: number;
  dailyLimit: number;
  spentToday: number;
  approvedCategories: string[];
  clearances: Array<{ agent: string; categories: string[] }>;
}

/** Fold observed decision facts into an org policy view (latest wins for caps). */
function derivePolicy(decisions: DecisionView[]): PolicyModel | null {
  const withFacts = decisions.filter(
    (d): d is DecisionView & { facts: Facts } => d.facts !== null,
  );
  if (withFacts.length === 0) return null;

  // decisions are newest-first; the first with facts carries the current caps.
  const latest = withFacts[0]!.facts;
  const approved = new Set<string>();
  const clearanceMap = new Map<string, Set<string>>();

  for (const d of withFacts) {
    for (const c of d.facts.approved_categories) approved.add(c);
    const set = clearanceMap.get(d.agentId) ?? new Set<string>();
    for (const c of d.facts.agent_cleared_categories) set.add(c);
    clearanceMap.set(d.agentId, set);
  }

  return {
    currency: withFacts[0]!.request?.currency ?? "USD",
    perTxnCap: latest.per_txn_cap,
    dailyLimit: latest.daily_limit,
    spentToday: latest.daily_total_so_far,
    approvedCategories: [...approved].sort(),
    clearances: [...clearanceMap.entries()]
      .map(([agent, cats]) => ({ agent, categories: [...cats].sort() }))
      .sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

function PolicyBody({ p }: { p: PolicyModel }): JSX.Element {
  const fill = p.dailyLimit > 0 ? Math.min(1, p.spentToday / p.dailyLimit) : 0;
  const over = p.spentToday > p.dailyLimit;
  const barStyle = { "--fill": String(fill) } as CSSProperties;

  return (
    <>
      <div className="kpi-row" style={{ marginBottom: 20 }}>
        <StatTile label="Per-transaction cap" value={formatMoney(p.perTxnCap, p.currency)} hint="max single spend" tone="info" />
        <StatTile label="Daily limit" value={formatMoney(p.dailyLimit, p.currency)} hint="org daily ceiling" tone="info" />
        <StatTile label="Approved categories" value={p.approvedCategories.length} tone="accent" />
        <StatTile label="Cleared agents" value={p.clearances.length} tone="neutral" />
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Spend vs. daily limit</h3>
          <p className="card-sub">
            Most recent recorded daily total against the org cap ({formatMoney(p.dailyLimit, p.currency)}).
          </p>
          <div className="kbar" role="img" aria-label={`Spent ${formatMoney(p.spentToday, p.currency)} of ${formatMoney(p.dailyLimit, p.currency)}`}>
            <span className={over ? "over" : ""} style={barStyle} />
          </div>
          <p className="card-sub" style={{ margin: "10px 0 0" }}>
            {formatMoney(p.spentToday, p.currency)} spent{over ? " — over limit" : ""}.
          </p>
        </div>

        <div className="card">
          <h3>Approved categories</h3>
          <p className="card-sub">The org-approved spend categories the kernel checks against.</p>
          {p.approvedCategories.length > 0 ? (
            <div className="cell-rules">
              {p.approvedCategories.map((c) => (
                <span key={c} className="rule-tag">
                  {c}
                </span>
              ))}
            </div>
          ) : (
            <p className="card-sub" style={{ margin: 0 }}>None observed yet.</p>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Agent clearances</h3>
        <p className="card-sub">
          Which categories each agent may spend in — from the ledger, not model narration.
        </p>
        <div className="table-wrap">
          <table className="dtable">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Cleared categories</th>
              </tr>
            </thead>
            <tbody>
              {p.clearances.map((c) => (
                <tr key={c.agent} style={{ cursor: "default" }}>
                  <td data-label="Agent" className="mono-cell">
                    {c.agent}
                  </td>
                  <td data-label="Cleared categories">
                    <div className="cell-rules">
                      {c.categories.length > 0 ? (
                        c.categories.map((cat) => (
                          <span key={cat} className="rule-tag">
                            {cat}
                          </span>
                        ))
                      ) : (
                        <span className="card-sub">none</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export function Policy(): JSX.Element {
  const state = useAsync((signal) => fetchDecisions({ limit: 100 }, signal), []);

  useEffect(() => {
    document.title = "Policy · Provable Agent Spend";
  }, []);

  return (
    <>
      <div className="page-head">
        <h2>Policy</h2>
        <p>
          The caps and clearances the deterministic kernel enforces — derived from the
          authoritative facts on recorded decisions, so it mirrors exactly what was evaluated.
        </p>
      </div>

      {state.status === "loading" ? (
        <>
          <Skeleton style={{ height: 84, marginBottom: 20 }} />
          <div className="grid two">
            <Skeleton style={{ height: 150 }} />
            <Skeleton style={{ height: 150 }} />
          </div>
        </>
      ) : state.status === "error" ? (
        <BridgeErrorState error={state.error} onRetry={state.reload} />
      ) : (
        (() => {
          const p = derivePolicy(state.data.decisions);
          return p ? (
            <PolicyBody p={p} />
          ) : (
            <StateCard icon="▤" title="No policy facts yet">
              Policy limits and clearances appear here once decisions with authoritative
              facts are recorded. Trigger a <code>pay_vendor</code> call to populate them.
            </StateCard>
          );
        })()
      )}
    </>
  );
}

export default Policy;

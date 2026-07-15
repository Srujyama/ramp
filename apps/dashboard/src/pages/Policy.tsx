import type { CSSProperties, JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDecisions, simulatePolicy } from "../lib/bridge.js";
import { useAsync } from "../lib/useAsync.js";
import { formatMoney, ruleTitle, explainSimulation } from "../lib/format.js";
import type { StatusChip } from "../lib/format.js";
import type { DecisionView, Facts, SimulationResult } from "../lib/types.js";
import {
  EMPTY_SIM_FORM,
  SCENARIOS,
  policyChecks,
  scenarioToForm,
  truncateDigest,
  validateSimForm,
  type SimField,
  type SimFormValues,
} from "../lib/simulator.js";
import StatTile from "../components/StatTile.js";
import { BridgeErrorState, Chip, CopyId, StateCard, Skeleton } from "../components/ui.js";

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
          <p className="card-sub">The org-approved spend categories the policy engine checks against.</p>
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

// --- Policy Simulator (read-only, hypothetical) ------------------------------

type SimRun =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; result: SimulationResult };

/**
 * Read-only "what would the kernel decide?" tool. It tests HYPOTHETICAL spend
 * requests via an idempotent GET (`simulatePolicy`) and renders the verdict —
 * it NEVER edits policy, persists a decision, produces a proof, or executes a
 * payment. There is no mutating call reachable from this component; the only
 * network access is the read-only simulate endpoint.
 */
function PolicySimulator(): JSX.Element {
  const [form, setForm] = useState<SimFormValues>(EMPTY_SIM_FORM);
  const [errors, setErrors] = useState<Partial<Record<SimField, string>>>({});
  const [run, setRun] = useState<SimRun>({ status: "idle" });
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => () => acRef.current?.abort(), []);

  const setField = (field: SimField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [field]: value }));
  };

  const execute = useCallback(() => {
    const v = validateSimForm(form);
    setErrors(v.errors);
    if (!v.valid) return;

    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setRun({ status: "loading" });

    simulatePolicy(
      {
        agent: form.agent.trim(),
        vendor: form.vendor.trim(),
        amount: v.amount,
        category: form.category.trim(),
        currency: form.currency.trim() || undefined,
      },
      ac.signal,
    ).then(
      (result) => {
        if (!ac.signal.aborted) setRun({ status: "success", result });
      },
      (error) => {
        if (ac.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRun({ status: "error", error });
      },
    );
  }, [form]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    execute();
  };

  const loading = run.status === "loading";

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Policy simulator</h3>
      <p className="card-sub">
        Test a <strong>hypothetical</strong> purchase against the exact policy that is
        enforced. Simulation is side-effect free — no decision is recorded, no proof
        produced, and no payment executed.
      </p>

      <div className="cell-rules" style={{ margin: "10px 0 14px" }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="btn ghost"
            style={{ fontSize: 12 }}
            title={`${s.note} (prefills the form — does not run)`}
            onClick={() => {
              setForm(scenarioToForm(s));
              setErrors({});
            }}
          >
            {s.expect === "allow" ? "✓ " : "✗ "}
            {s.title}
          </button>
        ))}
      </div>

      <form className="filter-bar" style={{ alignItems: "flex-start" }} onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="sim-agent">Agent</label>
          <input
            id="sim-agent"
            className="text-input"
            type="text"
            value={form.agent}
            onChange={setField("agent")}
            placeholder="agent_47"
            autoComplete="off"
            aria-invalid={errors.agent ? true : undefined}
          />
          {errors.agent ? <span role="alert" style={{ fontSize: 11.5, color: "var(--deny-ink)" }}>{errors.agent}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="sim-vendor">Vendor</label>
          <input
            id="sim-vendor"
            className="text-input"
            type="text"
            value={form.vendor}
            onChange={setField("vendor")}
            placeholder="acme_corp"
            autoComplete="off"
            aria-invalid={errors.vendor ? true : undefined}
          />
          {errors.vendor ? <span role="alert" style={{ fontSize: 11.5, color: "var(--deny-ink)" }}>{errors.vendor}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="sim-amount">Amount</label>
          <input
            id="sim-amount"
            className="text-input"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={form.amount}
            onChange={setField("amount")}
            placeholder="340"
            aria-invalid={errors.amount ? true : undefined}
          />
          {errors.amount ? <span role="alert" style={{ fontSize: 11.5, color: "var(--deny-ink)" }}>{errors.amount}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="sim-category">Category</label>
          <input
            id="sim-category"
            className="text-input"
            type="text"
            value={form.category}
            onChange={setField("category")}
            placeholder="office_supplies"
            autoComplete="off"
            aria-invalid={errors.category ? true : undefined}
          />
          {errors.category ? <span role="alert" style={{ fontSize: 11.5, color: "var(--deny-ink)" }}>{errors.category}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="sim-currency">Currency</label>
          <input
            id="sim-currency"
            className="text-input"
            type="text"
            value={form.currency}
            onChange={setField("currency")}
            placeholder="USD"
            maxLength={3}
            autoComplete="off"
            style={{ minWidth: 90, textTransform: "uppercase" }}
          />
        </div>

        <div className="field">
          <label aria-hidden="true" style={{ visibility: "hidden" }}>Run</label>
          <button type="submit" className="btn primary" disabled={loading}>
            {loading ? "Simulating…" : "Simulate"}
          </button>
        </div>
      </form>

      <SimOutput run={run} onRetry={execute} />
    </div>
  );
}

/** The result panel: idle hint, error, or the read-only verdict. */
function SimOutput({ run, onRetry }: { run: SimRun; onRetry: () => void }): JSX.Element {
  if (run.status === "idle") {
    return (
      <p className="card-sub" style={{ margin: "14px 0 0" }}>
        Fill the form (or pick a scenario above) and run a simulation to see the verdict,
        the checks the policy examined, and the policy digest it was evaluated against.
      </p>
    );
  }

  if (run.status === "loading") {
    return <Skeleton style={{ height: 120, marginTop: 14 }} />;
  }

  if (run.status === "error") {
    return (
      <div style={{ marginTop: 14 }}>
        <BridgeErrorState error={run.error} onRetry={onRetry} />
      </div>
    );
  }

  const { result } = run;
  const allowed = result.outcome === "allow";
  const chip: StatusChip = allowed
    ? { label: "Allowed", tone: "accent", title: "The policy would allow this hypothetical spend — every condition held." }
    : { label: "Denied", tone: "deny", title: "The policy would deny this hypothetical spend." };
  const checks = policyChecks(result.facts, result.currency);

  return (
    <div className="sim-result">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Chip chip={chip} />
        <span className="chip neutral" title="This tool only simulates — it never records a decision, produces a proof, or executes a payment.">
          Simulation only — no payment executed
        </span>
      </div>

      <p style={{ margin: "12px 0 0", fontSize: 14, color: "var(--ink)" }}>
        {explainSimulation(result.outcome, result.firedRules)}
      </p>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Rules that fired</h4>
          {result.firedRules.length > 0 ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {result.firedRules.map((id) => (
                <li key={id}>
                  <div style={{ fontSize: 13, fontWeight: 560, color: "var(--ink)" }}>
                    {ruleTitle(id)}
                  </div>
                  <span className="rule-tag">{id}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="card-sub" style={{ margin: 0 }}>No rules fired.</p>
          )}
        </div>

        <div>
          <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Policy checks evaluated</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {checks.map((c) => (
              <li key={c.key} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span
                  aria-hidden="true"
                  style={{
                    color: c.pass ? "var(--accent)" : "var(--deny)",
                    fontWeight: 700,
                    lineHeight: 1.3,
                  }}
                >
                  {c.pass ? "✓" : "✗"}
                </span>
                <div>
                  <div style={{ fontSize: 13, color: "var(--ink)" }}>
                    {c.label}
                    <span className="visually-hidden">{c.pass ? " — passed" : " — failed"}</span>
                  </div>
                  <div className="card-sub" style={{ margin: 0 }}>{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <CopyId
          id={result.policyDigest}
          label={`Policy digest: ${truncateDigest(result.policyDigest)}`}
        />
        <span className="card-sub" style={{ margin: 0 }}>
          ties this simulation to the exact policy identity
        </span>
      </div>
    </div>
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
          The caps and clearances the deterministic policy engine enforces — derived from the
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

      <PolicySimulator />
    </>
  );
}

export default Policy;

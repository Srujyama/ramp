import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, JSX } from "react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { simulatePolicy } from "../../lib/bridge.js";
import { formatMoney, ruleTitle, explainSimulation, type StatusChip as StatusChipModel } from "../../lib/format.js";
import { agentLabel } from "../../lib/identity.js";
import {
  EMPTY_SIM_FORM,
  SCENARIOS,
  policyChecks,
  scenarioToForm,
  truncateDigest,
  validateSimForm,
  type SimField,
  type SimFormValues,
} from "../../lib/simulator.js";
import type { DecisionView, Facts, SimulationResult } from "../../lib/types.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { StatusChip } from "../../components/StatusChip.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Progress } from "../../components/ui/progress.js";
import { CopyId } from "../../components/ui/copy-id.js";
import { Check, X } from "lucide-react";

// --- org policy overview (derived from recorded facts, never hand-entered) --

interface PolicyModel {
  currency: string;
  perTxnCap: number;
  dailyLimit: number;
  spentToday: number;
  approvedCategories: string[];
  clearances: Array<{ agent: string; categories: string[] }>;
}

function derivePolicy(decisions: DecisionView[]): PolicyModel | null {
  const withFacts = decisions.filter((d): d is DecisionView & { facts: Facts } => d.facts !== null);
  if (withFacts.length === 0) return null;

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
              <CardDescription>Most recent recorded daily total against the org cap.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={fill} tone={over ? "flag" : "lime"} />
            <p className="mt-2.5 text-[13px] text-ink-muted">
              {formatMoney(p.spentToday, p.currency)} spent{over ? " — over limit" : ""} of{" "}
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
                  <span key={c} className="rounded bg-surface-sunken px-2 py-1 text-[11.5px] text-ink-muted">
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
            <CardDescription>Which categories each agent may spend in — from the ledger, not model narration.</CardDescription>
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
                            <span key={cat} className="rounded bg-surface-sunken px-2 py-1 text-[11.5px] text-ink-muted">
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

// --- policy simulator (read-only, hypothetical) ------------------------------

type SimRun =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; result: SimulationResult };

function verdictChip(outcome: SimulationResult["outcome"]): StatusChipModel {
  if (outcome === "allow") {
    return { label: "Allowed", tone: "accent", title: "The policy would allow this hypothetical spend — every condition held." };
  }
  if (outcome === "escalate") {
    return { label: "Needs approval", tone: "warn", title: "The policy would hold this for a human — not denied, not paid." };
  }
  return { label: "Denied", tone: "deny", title: "The policy would deny this hypothetical spend." };
}

function PolicySimulator(): JSX.Element {
  const [form, setForm] = useState<SimFormValues>(EMPTY_SIM_FORM);
  const [errors, setErrors] = useState<Partial<Record<SimField, string>>>({});
  const [run, setRun] = useState<SimRun>({ status: "idle" });
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => () => acRef.current?.abort(), []);

  const setField = (field: SimField) => (e: ChangeEvent<HTMLInputElement>) => {
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
      (error: unknown) => {
        if (ac.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRun({ status: "error", error });
      },
    );
  }, [form]);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    execute();
  }

  const loading = run.status === "loading";

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Policy simulator</CardTitle>
          <CardDescription>
            Test a <strong>hypothetical</strong> purchase against the exact enforced policy. Side-effect free — no
            decision, proof, or payment.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              title={`${s.note} (prefills the form — does not run)`}
              onClick={() => {
                setForm(scenarioToForm(s));
                setErrors({});
              }}
              className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-hover hover:text-ink"
            >
              {s.expect === "allow" ? "✓ " : s.expect === "escalate" ? "◐ " : "✗ "}
              {s.title}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-agent" className="text-[11px] font-medium text-ink-faint">
              Agent
            </label>
            <Input id="sim-agent" value={form.agent} onChange={setField("agent")} placeholder="agent_47" autoComplete="off" className="h-8 w-36 text-[12.5px]" aria-invalid={errors.agent ? true : undefined} />
            {errors.agent ? <span className="text-[11px] text-flag-ink">{errors.agent}</span> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-vendor" className="text-[11px] font-medium text-ink-faint">
              Vendor
            </label>
            <Input id="sim-vendor" value={form.vendor} onChange={setField("vendor")} placeholder="acme_corp" autoComplete="off" className="h-8 w-36 text-[12.5px]" aria-invalid={errors.vendor ? true : undefined} />
            {errors.vendor ? <span className="text-[11px] text-flag-ink">{errors.vendor}</span> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-amount" className="text-[11px] font-medium text-ink-faint">
              Amount
            </label>
            <Input id="sim-amount" type="number" inputMode="numeric" min={0} step={1} value={form.amount} onChange={setField("amount")} placeholder="340" className="h-8 w-28 text-[12.5px]" aria-invalid={errors.amount ? true : undefined} />
            {errors.amount ? <span className="text-[11px] text-flag-ink">{errors.amount}</span> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-category" className="text-[11px] font-medium text-ink-faint">
              Category
            </label>
            <Input id="sim-category" value={form.category} onChange={setField("category")} placeholder="office_supplies" autoComplete="off" className="h-8 w-40 text-[12.5px]" aria-invalid={errors.category ? true : undefined} />
            {errors.category ? <span className="text-[11px] text-flag-ink">{errors.category}</span> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-currency" className="text-[11px] font-medium text-ink-faint">
              Currency
            </label>
            <Input id="sim-currency" value={form.currency} onChange={setField("currency")} placeholder="USD" maxLength={3} autoComplete="off" className="h-8 w-20 text-[12.5px] uppercase" />
          </div>
          <Button type="submit" size="sm" disabled={loading} className="h-8">
            {loading ? "Simulating…" : "Simulate"}
          </Button>
        </form>

        <SimOutput run={run} onRetry={execute} />
      </CardContent>
    </Card>
  );
}

function SimOutput({ run, onRetry }: { run: SimRun; onRetry: () => void }): JSX.Element | null {
  if (run.status === "idle") {
    return (
      <p className="mt-4 text-[13px] text-ink-muted">
        Fill the form (or pick a scenario above) and run a simulation to see the verdict, the checks the policy
        examined, and the policy digest it was evaluated against.
      </p>
    );
  }
  if (run.status === "loading") {
    return <Skeleton className="mt-4 h-32 w-full" />;
  }
  if (run.status === "error") {
    return (
      <div className="mt-4">
        <BridgeErrorState error={run.error} onRetry={onRetry} />
      </div>
    );
  }

  const { result } = run;
  const checks = policyChecks(result.facts, result.currency);

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip chip={verdictChip(result.outcome)} />
        <span
          title="This tool only simulates — it never records a decision, produces a proof, or executes a payment."
          className="rounded-full bg-surface-sunken px-2.5 py-1 text-[11.5px] text-ink-faint"
        >
          Simulation only — no payment executed
        </span>
      </div>

      <p className="mt-3 text-[14px] text-ink">{explainSimulation(result.outcome, result.firedRules)}</p>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-[12.5px] font-semibold text-ink">Rules that fired</h4>
          {result.firedRules.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {result.firedRules.map((id) => (
                <li key={id}>
                  <div className="text-[13px] font-medium text-ink">{ruleTitle(id)}</div>
                  <span className="font-mono text-[11px] text-ink-faint">{id}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-muted">No rules fired.</p>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-[12.5px] font-semibold text-ink">Policy checks evaluated</h4>
          <ul className="flex flex-col gap-2.5">
            {checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                {c.pass ? <Check className="mt-0.5 size-3.5 shrink-0 text-lime" /> : <X className="mt-0.5 size-3.5 shrink-0 text-flag" />}
                <div>
                  <div className="text-[13px] text-ink">{c.label}</div>
                  <div className="text-[12px] text-ink-faint">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <CopyId id={result.policyDigest} label={`Policy digest: ${truncateDigest(result.policyDigest)}`} />
        <span className="text-[12px] text-ink-faint">ties this simulation to the exact policy identity</span>
      </div>
    </div>
  );
}

export function Policy(): JSX.Element {
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = "Policy · Provable Agent Spend";
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Policy</h1>
        <p className="text-[13.5px] text-ink-muted">
          The caps and clearances the deterministic policy engine enforces — derived from recorded facts, plus a
          read-only simulator to preview any purchase.
        </p>
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

      <PolicySimulator />
    </div>
  );
}

export default Policy;

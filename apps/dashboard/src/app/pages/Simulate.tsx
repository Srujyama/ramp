import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Play, ShieldCheck, ArrowRight, CircleAlert } from "lucide-react";
import { postTransaction, ControlPlaneError, CONTROL_PLANE_URL, type TxIntent, type TxResult } from "../../lib/controlPlane.js";
import { Card, CardContent } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";

type Form = { agent: string; vendor: string; amount: string; category: string; attest: boolean };

const PRESETS: { label: string; expect: string; tone: "accent" | "deny" | "warn"; form: Form }[] = [
  { label: "Valid payment", expect: "allows", tone: "accent", form: { agent: "agent_47", vendor: "acme_corp", amount: "150", category: "office_supplies", attest: true } },
  { label: "Over the threshold", expect: "held", tone: "warn", form: { agent: "agent_12", vendor: "acme_corp", amount: "450", category: "office_supplies", attest: true } },
  { label: "Unverified vendor", expect: "denies", tone: "deny", form: { agent: "agent_47", vendor: "sketchy_llc", amount: "50", category: "office_supplies", attest: true } },
  { label: "Over the cap", expect: "denies", tone: "deny", form: { agent: "agent_47", vendor: "acme_corp", amount: "9000", category: "office_supplies", attest: true } },
  { label: "No attestation", expect: "denies", tone: "deny", form: { agent: "agent_47", vendor: "acme_corp", amount: "150", category: "office_supplies", attest: false } },
];

function outcomeBadge(outcome: TxResult["outcome"]): JSX.Element {
  if (outcome === "allow") return <Badge tone="accent">ALLOWED</Badge>;
  if (outcome === "escalate") return <Badge tone="warn">HELD FOR A HUMAN</Badge>;
  return <Badge tone="deny">DENIED</Badge>;
}

export function Simulate(): JSX.Element {
  const [form, setForm] = useState<Form>(PRESETS[0]!.form);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TxResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = "Simulate · Warrant";
  }, []);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  async function run(): Promise<void> {
    const amount = Number(form.amount);
    if (!Number.isInteger(amount) || amount < 0) {
      setError(new Error("Amount must be a whole, non-negative number (money is integer units)."));
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    const intent: TxIntent = { agent: form.agent.trim(), vendor: form.vendor.trim(), amount, category: form.category.trim(), attest: form.attest };
    try {
      setResult(await postTransaction(intent));
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Simulate a transaction</h1>
        <p className="text-[13.5px] text-ink-muted">
          Trigger a spend request without an MCP terminal. Each run is a{" "}
          <span className="font-medium text-ink">real gated decision</span> through the same policy kernel: the outcome
          falls out of policy, it isn't faked, and it's recorded in the append-only log and streamed live to Activity.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setForm(p.form);
              setResult(null);
              setError(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            {p.label}
            <Badge tone={p.tone}>{p.expect}</Badge>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="grid gap-4 py-5 sm:grid-cols-2">
          <Field label="Requesting agent">
            <Input value={form.agent} onChange={(e) => set({ agent: e.target.value })} placeholder="agent_47" />
          </Field>
          <Field label="Vendor">
            <Input value={form.vendor} onChange={(e) => set({ vendor: e.target.value })} placeholder="acme_corp" />
          </Field>
          <Field label="Amount (whole units)">
            <Input value={form.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="numeric" placeholder="150" />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={(e) => set({ category: e.target.value })} placeholder="office_supplies" />
          </Field>
          <label className="col-span-full flex items-center gap-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={form.attest}
              onChange={(e) => set({ attest: e.target.checked })}
              className="size-4 rounded border-line-strong accent-lime"
            />
            <ShieldCheck className="size-4 text-ink-faint" />
            Attach a valid notary attestation (bound to the vendor's registered domain)
          </label>
          <div className="col-span-full flex items-center gap-3">
            <Button onClick={run} disabled={running}>
              <Play className="size-4" /> {running ? "Running…" : "Run transaction"}
            </Button>
            <span className="text-[12px] text-ink-faint">Sandbox. No real money moves.</span>
          </div>
        </CardContent>
      </Card>

      {error !== null ? (
        <Card>
          <CardContent className="flex items-start gap-3 py-4">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            <p className="text-[13px] text-ink-muted">
              {error instanceof ControlPlaneError && error.kind === "unavailable" ? (
                <>
                  The demo control plane isn't reachable. Start it with{" "}
                  <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code> (
                  <span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
                </>
              ) : (
                <>{(error as Error)?.message ?? "Something went wrong."}</>
              )}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {result !== null ? (
        <Card className={cn(result.outcome === "allow" ? "border-lime/40" : result.outcome === "escalate" ? "border-amber/40" : "border-flag/40")}>
          <CardContent className="flex flex-col gap-3 py-5">
            <div className="flex items-center gap-3">
              {outcomeBadge(result.outcome)}
              <span className="text-[13px] text-ink-muted">This is a real, recorded decision.</span>
            </div>
            {result.reasons.length > 0 ? (
              <p className="text-[13px] leading-relaxed text-ink">{result.reasons[0]}</p>
            ) : null}
            {result.firedRules.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {result.firedRules.map((r) => (
                  <span key={r} className="rounded bg-surface-sunken px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                    {r}
                  </span>
                ))}
              </div>
            ) : null}
            {result.decisionId ? (
              <Link
                to={`/app/activity/${encodeURIComponent(result.decisionId)}`}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-lime-ink hover:underline"
              >
                View the sealed decision + proof <ArrowRight className="size-3.5" />
              </Link>
            ) : null}
            <p className="text-[12px] text-ink-faint">It's already streaming into the Activity feed.</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-medium text-ink-faint">{label}</label>
      {children}
    </div>
  );
}

export default Simulate;

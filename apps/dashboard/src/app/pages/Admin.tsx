import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Plus, SlidersHorizontal, ShieldCheck, ArrowRight, CircleAlert, Check } from "lucide-react";
import {
  fetchAdminState,
  createAgent,
  updateDials,
  ControlPlaneError,
  CONTROL_PLANE_URL,
  type AdminState,
  type Dials,
} from "../../lib/controlPlane.js";
import { Card, CardContent } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";

/** Turn an unknown error into a human line the control-plane-down case makes actionable. */
function errline(e: unknown): JSX.Element {
  if (e instanceof ControlPlaneError && e.kind === "unavailable") {
    return (
      <>
        The demo control plane isn't reachable. Start it with{" "}
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code> (
        <span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
      </>
    );
  }
  return <>{(e as Error)?.message ?? "Something went wrong."}</>;
}

function ErrorCard({ error }: { error: unknown }): JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-4">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
        <p className="text-[13px] text-ink-muted">{errline(error)}</p>
      </CardContent>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-medium text-ink-faint">{label}</label>
      {children}
      {hint ? <span className="text-[11px] text-ink-faint">{hint}</span> : null}
    </div>
  );
}

export function Admin(): JSX.Element {
  const [state, setState] = useState<AdminState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    document.title = "Admin · Provable Agent Spend";
    const ac = new AbortController();
    fetchAdminState(ac.signal)
      .then(setState)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setLoadError(e);
      });
    return () => ac.abort();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Policy admin</h1>
        <p className="max-w-2xl text-[13.5px] text-ink-muted">
          Register an agent or retune the org dials — the <span className="font-medium text-ink">inputs</span> a decision
          is computed from. These change what the <span className="font-medium text-ink">next</span> decision will be; they
          can never rewrite one already sealed in the append-only log. Edit a dial here, then run the same transaction on{" "}
          <Link to="/app/simulate" className="font-medium text-lime-ink hover:underline">
            Simulate
          </Link>{" "}
          and watch the gate decide differently.
        </p>
      </div>

      {loadError !== null ? <ErrorCard error={loadError} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <CreateAgentCard categories={state?.categories ?? null} onCreated={() => void 0} />
        <DialsCard dials={state?.dials ?? null} onSaved={(d) => setState((s) => (s ? { ...s, dials: d } : s))} />
      </div>
    </div>
  );
}

// --- create agent ------------------------------------------------------------

function CreateAgentCard({
  categories,
  onCreated,
}: {
  categories: readonly string[] | null;
  onCreated: () => void;
}): JSX.Element {
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);

  function toggle(cat: string): void {
    setCleared((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createAgent({ agentId: agentId.trim(), displayName: displayName.trim(), clearedCategories: [...cleared] });
      setOk(`Registered ${res.agentId} — cleared for ${res.clearedCategories.length || "no"} categor${res.clearedCategories.length === 1 ? "y" : "ies"}.`);
      setAgentId("");
      setDisplayName("");
      setCleared(new Set());
      onCreated();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = agentId.trim() !== "" && displayName.trim() !== "" && !busy;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex items-center gap-2">
          <Plus className="size-4 text-ink-faint" />
          <h2 className="font-display text-[15px] font-semibold text-ink">New agent card</h2>
        </div>
        <p className="text-[12.5px] text-ink-muted">
          Provisions the agent registry + its category clearances. An unregistered agent is refused facts by the gate — so
          this is what makes a new agent spendable.
        </p>

        <Field label="Agent id" hint="A stable key, e.g. agent_88. Must be unique.">
          <Input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent_88" />
        </Field>
        <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Marketing Bot" />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-ink-faint">Cleared categories</span>
          {categories === null ? (
            <span className="text-[12px] text-ink-faint">Loading approved categories…</span>
          ) : categories.length === 0 ? (
            <span className="text-[12px] text-ink-faint">No approved categories.</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => {
                const on = cleared.has(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggle(cat)}
                    className={
                      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors " +
                      (on ? "border-lime/50 bg-lime-soft text-lime-ink" : "border-line bg-surface text-ink-muted hover:bg-surface-hover")
                    }
                  >
                    {on ? <Check className="size-3.5" /> : null}
                    {cat}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button onClick={submit} disabled={!canSubmit}>
            <Plus className="size-4" /> {busy ? "Creating…" : "Create agent"}
          </Button>
        </div>

        {ok !== null ? (
          <div className="flex items-start gap-2 rounded-lg border border-lime/40 bg-lime-soft px-3 py-2.5 text-[12.5px] text-lime-ink">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>{ok}</span>
          </div>
        ) : null}
        {error !== null ? (
          <div className="flex items-start gap-2 rounded-lg border border-flag/40 px-3 py-2.5 text-[12.5px] text-ink-muted">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            <span>{errline(error)}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- policy dials ------------------------------------------------------------

const DIALS: { key: keyof Dials; label: string; hint: string }[] = [
  { key: "perTxnCap", label: "Per-transaction cap", hint: "The most an agent may ever spend in one payment." },
  { key: "dailyLimit", label: "Daily limit", hint: "Max total an agent may spend in a day." },
  { key: "escalationThreshold", label: "Escalation threshold", hint: "Above this, a human must approve — even within the caps." },
  { key: "velocityLimit", label: "Velocity limit", hint: "Payment count that trips escalation over the rolling window." },
];

function DialsCard({ dials, onSaved }: { dials: Dials | null; onSaved: (d: Dials) => void }): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Seed the draft once the real dials arrive.
  useEffect(() => {
    if (dials) {
      setDraft({
        perTxnCap: String(dials.perTxnCap),
        dailyLimit: String(dials.dailyLimit),
        escalationThreshold: String(dials.escalationThreshold),
        velocityLimit: String(dials.velocityLimit),
      });
    }
  }, [dials]);

  async function save(): Promise<void> {
    const patch: Record<string, number> = {};
    for (const { key, label } of DIALS) {
      const raw = draft[key];
      if (raw === undefined || raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        setError(new Error(`${label} must be a whole, non-negative number (money is integer units).`));
        return;
      }
      if (dials && n === dials[key]) continue; // unchanged — don't send
      patch[key] = n;
    }
    if (Object.keys(patch).length === 0) {
      setError(new Error("Nothing changed — edit a dial before saving."));
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const next = await updateDials(patch);
      onSaved(next);
      setOk(`Saved. Every decision from now on is measured against the new dials.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-ink-faint" />
          <h2 className="font-display text-[15px] font-semibold text-ink">Policy dials</h2>
          <Badge tone="neutral">org-wide</Badge>
        </div>
        <p className="text-[12.5px] text-ink-muted">
          Whole-unit money, exactly as the kernel measures it. Retuning a dial re-decides nothing already sealed — it
          changes what the next decision is compared against.
        </p>

        <div className="grid gap-3.5 sm:grid-cols-2">
          {DIALS.map(({ key, label, hint }) => (
            <Field key={key} label={label} hint={hint}>
              <Input
                value={draft[key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                inputMode="numeric"
                placeholder={dials ? String(dials[key]) : "…"}
                disabled={dials === null}
              />
            </Field>
          ))}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button onClick={save} disabled={busy || dials === null}>
            <SlidersHorizontal className="size-4" /> {busy ? "Saving…" : "Save dials"}
          </Button>
          <Link to="/app/simulate" className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-lime-ink hover:underline">
            Test it on Simulate <ArrowRight className="size-3.5" />
          </Link>
        </div>

        {ok !== null ? (
          <div className="flex items-start gap-2 rounded-lg border border-lime/40 bg-lime-soft px-3 py-2.5 text-[12.5px] text-lime-ink">
            <Check className="mt-0.5 size-4 shrink-0" />
            <span>{ok}</span>
          </div>
        ) : null}
        {error !== null ? (
          <div className="flex items-start gap-2 rounded-lg border border-flag/40 px-3 py-2.5 text-[12.5px] text-ink-muted">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            <span>{errline(error)}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default Admin;

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Plus, SlidersHorizontal, ShieldCheck, ArrowRight, CircleAlert, Check, Database } from "lucide-react";
import {
  fetchAdminState,
  updateDials,
  setDemoData,
  ControlPlaneError,
  CONTROL_PLANE_URL,
  type AdminState,
  type Dials,
  type DemoDataResult,
} from "../../lib/controlPlane.js";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { Card, CardContent } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { CreateAgentModal } from "../../components/CreateAgentModal.js";
import { cn } from "../../lib/utils.js";

/** Turn an unknown error into a human line the control-plane-down case makes actionable. */
function errline(e: unknown): JSX.Element {
  if (e instanceof ControlPlaneError && e.kind === "unavailable") {
    return (
      <>
        The demo control plane isn't reachable. Start it with{" "}
        <code className="rounded-[--radius-xs] bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code> (
        <span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
      </>
    );
  }
  return <>{(e as Error)?.message ?? "Something went wrong."}</>;
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
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = "Admin · Warrant";
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
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Admin</h1>
        <p className="max-w-2xl text-[13.5px] text-ink-muted">
          Register an agent or retune the org dials, the <span className="font-medium text-ink">inputs</span> a decision
          is computed from. These change what the <span className="font-medium text-ink">next</span> decision will be; they
          can never rewrite one already sealed in the append-only log. Edit a dial here, then run the same transaction on{" "}
          <Link to="/app/simulate" className="font-medium text-lime-ink hover:underline">
            Simulate
          </Link>{" "}
          and watch the gate decide differently.
        </p>
      </div>

      {loadError !== null ? (
        <Card>
          <CardContent className="flex items-start gap-3 py-4">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            <p className="text-[13px] text-ink-muted">{errline(loadError)}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <CreateAgentTrigger />
          <DummyDataCard win={win} />
        </div>
        <DialsCard dials={state?.dials ?? null} onSaved={(d) => setState((s) => (s ? { ...s, dials: d } : s))} />
      </div>
    </div>
  );
}

// --- create agent (compact trigger onto the shared modal) --------------------

function CreateAgentTrigger(): JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <div className="flex items-center gap-2">
          <Plus className="size-4 text-ink-faint" />
          <h2 className="font-display text-[15px] font-semibold text-ink">Register a new agent</h2>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          An unregistered agent is refused facts by the gate, so this is what makes a new agent spendable.
        </p>
        <CreateAgentModal
          trigger={
            <Button className="self-start">
              <Plus className="size-4" /> Create agent
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

// --- dummy data toggle ---------------------------------------------------------

type DecisionsWindow = ReturnType<typeof useDecisionsWindow>;

/**
 * "Enabled" is a DERIVED fact, not a flag this UI tracks: a decision the demo
 * generator wrote always carries a request id prefixed `inv_h` (see
 * packages/ledger/src/demo-data.ts), so the switch position always reflects
 * what is actually in the log — it can never drift from server state the way a
 * locally-remembered boolean could.
 */
function hasDummyData(win: DecisionsWindow): boolean {
  return win.status === "success" && win.data.decisions.some((d) => d.requestId.startsWith("inv_h"));
}

function DummyDataCard({ win }: { win: DecisionsWindow }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastResult, setLastResult] = useState<DemoDataResult | null>(null);
  // Once the operator acts, the SERVER'S response is the source of truth — not a
  // re-derivation from the live decision window, which can lag (or read a stale
  // bridge) and flip the switch back on right after a clear. `null` = derive from
  // the log (fresh mount); a boolean = the last confirmed action.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);

  const enabled = confirmed ?? hasDummyData(win);
  const ready = win.status === "success";

  async function toggle(): Promise<void> {
    const target = !enabled;
    setBusy(true);
    setError(null);
    setLastResult(null);
    setConfirmed(target); // optimistic — the switch reflects the intent immediately
    try {
      const result = await setDemoData(target);
      setConfirmed(result.enabled); // authoritative
      setLastResult(result);
      win.reload();
    } catch (e) {
      setConfirmed(null); // failed — fall back to what the log says
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-ink-faint" />
          <h2 className="font-display text-[15px] font-semibold text-ink">Dummy data</h2>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Populates ~90 days of realistic purchasing history so the dashboard, charts, and Activity log are full
          immediately. Every decision is still judged by the real kernel and proof-sealed, only the requests are
          synthetic. Fully reversible: disabling wipes it and restores the calibrated base seed.
        </p>

        <label className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-ink">Enable dummy data</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable dummy data"
            onClick={toggle}
            disabled={busy || !ready}
            className={cn(
              "inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              enabled ? "bg-lime" : "border border-line-strong bg-surface-sunken",
            )}
          >
            <span
              className={cn(
                "block size-5 rounded-full bg-white shadow-sm transition-transform duration-150",
                enabled ? "translate-x-5" : "translate-x-0",
              )}
            />
          </button>
        </label>

        {busy ? <p className="text-[12px] text-ink-faint">{enabled ? "Clearing…" : "Populating ~90 days…"}</p> : null}
        {lastResult !== null && !busy ? (
          <div className="flex items-start gap-2 rounded-[--radius-sm] border border-lime/40 bg-lime-soft px-3 py-2.5 text-[12.5px] text-lime-ink">
            <Check className="mt-0.5 size-4 shrink-0" />
            <span>
              {lastResult.enabled
                ? `Populated ${lastResult.written ?? 0} decisions across ${lastResult.days ?? 90} days.`
                : "Cleared. Back to the base seed."}
            </span>
          </div>
        ) : null}
        {error !== null ? (
          <div className="flex items-start gap-2 rounded-[--radius-sm] border border-flag/40 px-3 py-2.5 text-[12.5px] text-ink-muted">
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
  { key: "escalationThreshold", label: "Escalation threshold", hint: "Above this, a human must approve, even within the caps." },
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
      setError(new Error("Nothing changed. Edit a dial before saving."));
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
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Whole-unit money, exactly as the kernel measures it. Retuning a dial re-decides nothing already sealed, it
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
          <div className="flex items-start gap-2 rounded-[--radius-sm] border border-lime/40 bg-lime-soft px-3 py-2.5 text-[12.5px] text-lime-ink">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>{ok}</span>
          </div>
        ) : null}
        {error !== null ? (
          <div className="flex items-start gap-2 rounded-[--radius-sm] border border-flag/40 px-3 py-2.5 text-[12.5px] text-ink-muted">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            <span>{errline(error)}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default Admin;

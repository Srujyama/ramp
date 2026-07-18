import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Plus, ShieldCheck, CircleAlert, Check } from "lucide-react";
import { fetchAdminState, createAgent, ControlPlaneError, CONTROL_PLANE_URL } from "../lib/controlPlane.js";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { cn } from "../lib/utils.js";

function errline(e: unknown): ReactNode {
  if (e instanceof ControlPlaneError && e.kind === "unavailable") {
    return (
      <>
        The demo control plane isn't reachable. Start it with{" "}
        <code className="rounded-[--radius-xs] bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code>{" "}
        (<span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
      </>
    );
  }
  return <>{(e as Error)?.message ?? "Something went wrong."}</>;
}

/**
 * The single "register an agent" flow, shared by the Dashboard's agent row and
 * Admin — a focused modal, not a second page. Registers the agent + its
 * category clearances; an unregistered agent is refused facts by the gate,
 * so this is what makes a new agent spendable.
 */
export function CreateAgentModal({ trigger, onCreated }: { trigger: JSX.Element; onCreated?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<readonly string[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetchAdminState(ac.signal)
      .then((s) => setCategories(s.categories))
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setLoadError(e);
      });
    return () => ac.abort();
  }, [open]);

  function toggle(cat: string): void {
    setCleared((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function reset(): void {
    setAgentId("");
    setDisplayName("");
    setCleared(new Set());
    setError(null);
    setOk(null);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createAgent({ agentId: agentId.trim(), displayName: displayName.trim(), clearedCategories: [...cleared] });
      setOk(`Registered ${res.agentId}, cleared for ${res.clearedCategories.length || "no"} categor${res.clearedCategories.length === 1 ? "y" : "ies"}.`);
      setAgentId("");
      setDisplayName("");
      setCleared(new Set());
      onCreated?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = agentId.trim() !== "" && displayName.trim() !== "" && !busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create agent</DialogTitle>
          <DialogDescription>
            Registers the agent and its category clearances. An unregistered agent is refused facts by the gate.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-agent-id" className="text-[11px] font-medium text-ink-faint">
              Agent id
            </label>
            <Input id="new-agent-id" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent_88" autoComplete="off" />
            <span className="text-[11px] text-ink-faint">A stable key, e.g. agent_88. Must be unique.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-agent-name" className="text-[11px] font-medium text-ink-faint">
              Display name
            </label>
            <Input id="new-agent-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Marketing Bot" autoComplete="off" />
          </div>

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
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-[--radius-sm] border px-2.5 py-1 text-[12px] font-medium capitalize transition-colors",
                        on ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-muted hover:bg-surface-hover",
                      )}
                    >
                      {on ? <Check className="size-3.5" /> : null}
                      {cat.replace(/_/g, " ")}
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
            <div className="flex items-start gap-2 rounded-[--radius-sm] border border-lime/40 bg-lime-soft px-3 py-2.5 text-[12.5px] text-lime-ink">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              <span>{ok}</span>
            </div>
          ) : null}
          {error !== null || loadError !== null ? (
            <div className="flex items-start gap-2 rounded-[--radius-sm] border border-flag/40 px-3 py-2.5 text-[12.5px] text-ink-muted">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
              <span>{errline(error ?? loadError)}</span>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default CreateAgentModal;

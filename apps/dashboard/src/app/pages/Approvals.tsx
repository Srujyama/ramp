import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Check, X, ShieldCheck, Clock, CircleAlert, ArrowRight } from "lucide-react";
import {
  fetchApprovals,
  resolveApproval,
  ControlPlaneError,
  CONTROL_PLANE_URL,
  type PendingEscalation,
  type Approver,
} from "../../lib/controlPlane.js";
import { Card, CardContent } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { formatMoney, formatRelative } from "../../lib/format.js";
import { agentLabel, vendorLabel } from "../../lib/identity.js";

interface Resolved {
  decisionId: string;
  verdict: "approved" | "rejected";
  by: string;
}

export function Approvals(): JSX.Element {
  const [pending, setPending] = useState<PendingEscalation[] | null>(null);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [actingAs, setActingAs] = useState<string>("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, Resolved>>({});
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = "Approvals · Warrant";
    const ac = new AbortController();
    fetchApprovals(ac.signal)
      .then((r) => {
        setPending([...r.pending]);
        setApprovers([...r.approvers]);
        setActingAs((a) => a || r.approvers[0]?.keyId || "");
      })
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setError(e);
      });
    return () => ac.abort();
  }, []);

  async function resolve(id: string, verdict: "approved" | "rejected"): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const rec = await resolveApproval({ decisionId: id, verdict, approverKeyId: actingAs, note: notes[id] || undefined });
      setResolved((r) => ({ ...r, [id]: { decisionId: id, verdict: rec.verdict, by: rec.approvedBy } }));
      setPending((p) => (p ? p.filter((x) => x.decisionId !== id) : p));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const recentlyResolved = Object.values(resolved);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Approvals</h1>
          <p className="mt-0.5 max-w-2xl text-[13.5px] text-ink-muted">
            Held payments the gate could not settle on its own. A human must resolve each one. Every resolution is a{" "}
            <span className="font-medium text-ink">real Ed25519-signed record</span> bound to the decision's digest: the
            identity comes from the key, not a typed name.
          </p>
        </div>
        {approvers.length > 0 ? (
          <label className="flex items-center gap-2 text-[13px] text-ink-muted">
            Acting as
            <select
              value={actingAs}
              onChange={(e) => setActingAs(e.target.value)}
              className="h-9 rounded-[10px] border border-line bg-field px-3 text-[13px] font-medium text-ink outline-none focus-visible:border-info"
            >
              {approvers.map((a) => (
                <option key={a.keyId} value={a.keyId}>
                  {a.identity}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error !== null ? (
        <Card>
          <CardContent className="flex items-start gap-2.5 py-4 text-[13px] text-ink-muted">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            {error instanceof ControlPlaneError && error.kind === "unavailable" ? (
              <span>
                The demo control plane isn't reachable. Start it with{" "}
                <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code> (
                <span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
              </span>
            ) : (
              <span>{(error as Error)?.message ?? "Something went wrong."}</span>
            )}
          </CardContent>
        </Card>
      ) : null}

      {recentlyResolved.length > 0 ? (
        <div className="flex flex-col gap-2">
          {recentlyResolved.map((r) => (
            <div
              key={r.decisionId}
              className="flex items-center gap-2 rounded-[10px] border border-line bg-surface-sunken px-3.5 py-2.5 text-[13px]"
            >
              <ShieldCheck className="size-4 shrink-0 text-lime" />
              <span className="text-ink">
                {r.verdict === "approved" ? "Approved" : "Rejected"} by{" "}
                <span className="font-semibold">{r.by}</span>, signed &amp; recorded.
              </span>
              <Link
                to={`/app/activity/${encodeURIComponent(r.decisionId)}`}
                className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-lime-ink hover:underline"
              >
                View decision <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ))}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Clock className="size-4 text-amber" /> Awaiting a human
          </span>
          <span className="tabular text-[12.5px] text-ink-faint">
            {pending === null ? "…" : `${pending.length} held`}
          </span>
        </div>

        {pending === null ? (
          <div className="flex flex-col">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-line px-5 py-4">
                <Skeleton className="h-5 w-56" />
                <Skeleton className="ml-auto h-8 w-40" />
              </div>
            ))}
          </div>
        ) : pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-surface-sunken">
              <Check className="size-5 text-lime" />
            </span>
            <p className="text-[14px] font-medium text-ink">Nothing awaiting a human.</p>
            <p className="max-w-sm text-[13px] text-ink-muted">
              When a payment lands over the escalation threshold, it's held here for a signed approval instead of being
              paid or denied.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {pending.map((p) => (
              <div key={p.decisionId} className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line px-5 py-4 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[14px]">
                    <span className="font-semibold text-ink">{agentLabel(p.agentId)}</span>
                    <span className="text-ink-faint">&rarr;</span>
                    <span className="text-ink-muted">{vendorLabel(p.vendorId)}</span>
                    <span className="tabular text-[15px] font-semibold text-ink">{formatMoney(p.amount, "USD")}</span>
                  </span>
                  <span className="text-[12px] text-ink-faint">
                    {p.category.replace(/_/g, " ")} · held {formatRelative(p.ts, new Date())} ·{" "}
                    <Link to={`/app/activity/${encodeURIComponent(p.decisionId)}`} className="text-lime-ink hover:underline">
                      why?
                    </Link>
                  </span>
                </div>
                <Input
                  value={notes[p.decisionId] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [p.decisionId]: e.target.value }))}
                  placeholder="Note (optional)"
                  className="h-9 w-full max-w-[220px] sm:w-auto"
                />
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => resolve(p.decisionId, "rejected")}>
                    <X className="size-4" /> Reject
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => resolve(p.decisionId, "approved")}>
                    <Check className="size-4" /> {busy === p.decisionId ? "Signing…" : "Approve"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default Approvals;

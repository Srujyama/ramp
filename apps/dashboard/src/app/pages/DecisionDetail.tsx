import { useEffect } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { fetchDecision } from "../../lib/bridge.js";
import { useAsync } from "../../lib/useAsync.js";
import { formatMoney, formatTimestamp, outcomeChip, verificationChip, paymentChip, ruleTitle, ruleBlurb } from "../../lib/format.js";
import { agentLabel, vendorLabel } from "../../lib/identity.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card.js";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";
import { CopyId } from "../../components/ui/copy-id.js";
import { StatusChip } from "../../components/StatusChip.js";
import { ExecutionTimeline } from "../../components/ExecutionTimeline.js";
import { Rederive } from "../../components/Rederive.js";
import { Explain } from "../../components/Explain.js";
import type { DecisionView } from "../../lib/types.js";

function Row({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-[13px]">
      <dt className="shrink-0 text-ink-faint">{k}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

function KvList({ children }: { children: ReactNode }): JSX.Element {
  return <dl className="divide-y divide-line">{children}</dl>;
}

/** Full proof digests are a deep dive, not a default-open box — reachable, not omnipresent. */
function ProofDetailsDialog({ v }: { v: DecisionView }): JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          View proof details
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Proof</DialogTitle>
          <DialogDescription>Tamper-evident, independently recomputed on every read.</DialogDescription>
        </DialogHeader>
        <KvList>
          <Row k="Verification">
            <StatusChip chip={verificationChip(v.proofVerification.reason)} />
          </Row>
          <Row k="Proof id">{v.proof ? <CopyId id={v.proof.proofId} /> : "Not recorded"}</Row>
          <Row k="Policy digest">{v.proof?.policyDigest ? <CopyId id={v.proof.policyDigest} /> : "Not recorded"}</Row>
          <Row k="Request digest">{v.proof?.requestDigest ? <CopyId id={v.proof.requestDigest} /> : "Not recorded"}</Row>
          <Row k="Facts digest">{v.proof?.factsDigest ? <CopyId id={v.proof.factsDigest} /> : "Not recorded"}</Row>
          <Row k="Attestation">{v.proof?.attestationStatus ?? "Not recorded"}</Row>
          <Row k="Policy engine">{v.proof?.kernelId ?? v.kernelId ?? "Not recorded"}</Row>
        </KvList>
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({ v }: { v: DecisionView }): JSX.Element {
  const currency = v.request?.currency ?? "USD";
  const facts = v.facts;

  return (
    <div className="flex flex-col gap-5">
      <Link to="/app/activity" className="flex w-fit items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> All activity
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
            {agentLabel(v.agentId)} → {vendorLabel(v.vendorId)}
          </h1>
          <span className="tabular text-[20px] font-semibold text-ink">{formatMoney(v.amount, currency)}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusChip chip={outcomeChip(v)} />
          <StatusChip chip={verificationChip(v.proofVerification.reason)} />
          <StatusChip chip={paymentChip(v)} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px] text-ink-faint">
          <span>{formatTimestamp(v.ts)}</span>
          <CopyId id={v.decisionId} label={`Decision ${v.decisionId.slice(0, 14)}…`} />
          {v.proof?.policyDigest ? <CopyId id={v.proof.policyDigest} label={`Policy ${v.proof.policyDigest.slice(0, 18)}…`} /> : null}
        </div>
      </div>

      {v.corrupt ? (
        <div role="alert" className="flex items-start gap-2 rounded-[--radius-sm] border border-flag/30 bg-flag-soft/40 p-3.5 text-[13px] text-flag-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <strong>Corrupt record.</strong> At least one stored blob for this decision failed to parse or
            validate. Treat any parsed field below as suspect.
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Execution timeline</CardTitle>
            <CardDescription>The full lifecycle of this spend, top to bottom, derived only from the audit trail.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ExecutionTimeline view={v} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Request &amp; facts</CardTitle>
            <CardDescription>What the agent asked for, next to what the policy engine evaluated it against.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                Purchase request <span className="normal-case font-normal">(untrusted input)</span>
              </div>
              <KvList>
                <Row k="Agent">{agentLabel(v.agentId)}</Row>
                <Row k="Vendor">{vendorLabel(v.vendorId)}</Row>
                <Row k="Amount">{formatMoney(v.amount, currency)}</Row>
                <Row k="Category">{v.category.replace(/_/g, " ")}</Row>
                {v.request?.invoiceRef ? <Row k="Invoice">{v.request.invoiceRef}</Row> : null}
                <Row k="Request id">
                  <span className="font-mono text-[12px]">{v.requestId}</span>
                </Row>
              </KvList>
            </div>
            <div className="mt-4 sm:mt-0">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                Trusted facts <span className="normal-case font-normal">(ledger + registry)</span>
              </div>
              {facts ? (
                <KvList>
                  <Row k="Vendor verified">{facts.vendor_verified ? "Yes" : "No"}</Row>
                  <Row k="Vendor risk tier">{facts.vendor_risk_tier}</Row>
                  <Row k="Per-txn cap">{formatMoney(facts.per_txn_cap, currency)}</Row>
                  <Row k="Daily limit">{formatMoney(facts.daily_limit, currency)}</Row>
                  {/* A pre-decision snapshot, not a live total — label it as the
                      historical input it is, so it can't be read as spend-to-date. */}
                  <Row k="Spent today, before this">{formatMoney(facts.daily_total_so_far, currency)}</Row>
                  <Row k="Approved categories">{facts.approved_categories.join(", ") || "None recorded"}</Row>
                  <Row k="Agent cleared for">{facts.agent_cleared_categories.join(", ") || "None recorded"}</Row>
                  <Row k="Attestation">{facts.attestation_present ? "Present" : "Absent"}</Row>
                </KvList>
              ) : (
                <p className="text-[13px] text-ink-muted">No facts were recorded for this row.</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-semibold text-ink">Proof</span>
            <StatusChip chip={verificationChip(v.proofVerification.reason)} />
          </div>
          <ProofDetailsDialog v={v} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Fired rules</CardTitle>
              <CardDescription>Every policy rule the deterministic engine fired, stored verbatim.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {v.kernelId ? <p className="mb-2.5 text-[11.5px] text-ink-faint">engine · {v.kernelId}</p> : null}
            {v.firedRules.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {v.firedRules.map((r) => (
                  <span key={r} title={ruleBlurb(r)} className="rounded-[--radius-xs] bg-surface-sunken px-2 py-1 text-[11.5px] text-ink-muted">
                    {ruleTitle(r)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-muted">No rules fired.</p>
            )}
            {v.decision && v.decision.reasons.length > 0 ? (
              <ul className="mt-2.5 list-disc pl-4 text-[12.5px] text-ink-muted">
                {v.decision.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Payment · sandbox receipt</CardTitle>
              <CardDescription>No real money moves; a failed receipt is never shown as settled.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {v.execution ? (
              <KvList>
                <Row k="Status">
                  <StatusChip chip={paymentChip(v)} />
                </Row>
                <Row k="Receipt id">
                  <CopyId id={v.execution.receiptId} />
                </Row>
                <Row k="Execution id">
                  <span className="font-mono text-[12px]">{v.execution.executionId}</span>
                </Row>
                <Row k="Provider">{v.execution.provider} (sandbox)</Row>
                <Row k="Executed">{formatTimestamp(v.execution.executedAt)}</Row>
              </KvList>
            ) : (
              <p className="text-[13px] text-ink-muted">
                {v.outcome === "deny"
                  ? "No payment: the request was blocked by policy, so the executor was never called."
                  : v.outcome === "escalate"
                    ? "No payment: held for human approval, so the executor was never called."
                    : "No sandbox execution was recorded for this row (e.g. a gate-only policy check)."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Explain facts={v.facts} decision={v.decision} />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Re-derive the decision</CardTitle>
            <CardDescription>
              Don't take our word for it: run the real policy engine on the stored facts, here in your browser.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Rederive facts={v.facts} decision={v.decision} />
        </CardContent>
      </Card>
    </div>
  );
}

export function DecisionDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const state = useAsync((signal) => fetchDecision(id ?? "", signal), [id]);

  useEffect(() => {
    document.title = "Decision · Provable Agent Spend";
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return <BridgeErrorState error={state.error} onRetry={state.reload} />;
  }
  if (!id) {
    return (
      <StateCard icon="notfound" title="No decision id">
        This route needs a decision id.
      </StateCard>
    );
  }
  return <DetailBody v={state.data} />;
}

export default DecisionDetail;

import type { JSX, ReactNode } from "react";
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchDecision } from "../lib/bridge.js";
import { useAsync } from "../lib/useAsync.js";
import {
  formatMoney,
  formatTimestamp,
  outcomeChip,
  verificationChip,
  paymentChip,
  ruleTitle,
  ruleBlurb,
} from "../lib/format.js";
import type { StatusChip } from "../lib/format.js";
import { buildTimeline, type StageState } from "../lib/timeline.js";
import type { DecisionView } from "../lib/types.js";
import {
  Chip,
  CopyId,
  ProvenanceFlow,
  BridgeErrorState,
  StateCard,
  Skeleton,
} from "../components/ui.js";

/**
 * @ramp/dashboard — DecisionDetail
 *
 * "Prove this decision to an auditor." One evaluated spend request, expanded
 * into the full record — organized around the EXECUTION TIMELINE: the six-stage
 * lifecycle from the agent's request through trusted facts, policy evaluation,
 * the recorded decision, the independently re-verified proof, and the sandbox
 * payment. The timeline is the primary visualization; the trust ladder (outcome
 * / verification / payment) is folded INTO the relevant stages rather than shown
 * as separate status cards, so each claim is stated honestly and in place (a
 * deny reads as blocked, a proof mismatch as tampered, an unexecuted allow as
 * skipped). Below the timeline, the detailed record remains: facts, fired rules,
 * the full proof (ids + digests), provenance, and the execution receipt.
 */

/** Node colour class (reuses the existing .flow .node tones). */
function nodeTone(s: StageState): string {
  switch (s) {
    case "done":
      return "accent";
    case "blocked":
      return "warn";
    case "failed":
    case "corrupt":
      return "deny";
    case "pending":
      return "info";
    case "skipped":
      return "";
  }
}

/** Small uppercase state pill shown next to each stage title. */
const PILL: Record<StageState, { label: string; color: string }> = {
  done: { label: "Done", color: "var(--accent)" },
  blocked: { label: "Blocked", color: "var(--warn)" },
  failed: { label: "Failed", color: "var(--deny)" },
  corrupt: { label: "Corrupt", color: "var(--deny)" },
  skipped: { label: "Skipped", color: "var(--ink-faint)" },
  pending: { label: "Pending", color: "var(--info)" },
};

function StatePill({ state }: { state: StageState }): JSX.Element {
  const p = PILL[state];
  return (
    <span
      style={{
        border: `1px solid ${p.color}`,
        color: p.color,
        borderRadius: 999,
        padding: "0px 8px",
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        lineHeight: 1.7,
      }}
    >
      {p.label}
    </span>
  );
}

/** Label prefix for the id/digest surfaced on each stage. */
const META_LABEL: Record<string, string> = {
  request: "request",
  policy: "policy digest",
  decision: "decision",
  proof: "proof",
  payment: "receipt",
};

/** The trust-ladder chip folded into the relevant stage (no separate cards). */
function stageChip(v: DecisionView, key: string): StatusChip | null {
  if (key === "policy") return outcomeChip(v);
  if (key === "proof") return verificationChip(v.proofVerification.reason);
  if (key === "payment") return paymentChip(v);
  return null;
}

function Timeline({ v }: { v: DecisionView }): JSX.Element {
  const stages = buildTimeline(v);
  return (
    <ol className="flow">
      {stages.map((s) => {
        const chip = stageChip(v, s.key);
        return (
          <li key={s.key}>
            <span className={`node ${nodeTone(s.state)}`} aria-hidden="true" />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="f-title">{s.title}</span>
              <StatePill state={s.state} />
              {chip ? <Chip chip={chip} /> : null}
            </div>
            <div className="f-detail">{s.detail}</div>
            {s.meta ? (
              <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{META_LABEL[s.key] ?? "id"}</span>
                <span className="pid" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  <CopyId id={s.meta} />
                </span>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="card">
      <h3>{title}</h3>
      {sub ? <p className="card-sub">{sub}</p> : null}
      {children}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function DetailBody({ v }: { v: DecisionView }): JSX.Element {
  const currency = v.request?.currency ?? "USD";
  const facts = v.facts;
  const policyDigest = v.proof?.policyDigest ?? null;

  return (
    <>
      <Link to="/decisions" className="detail-back">
        ← All decisions
      </Link>

      <div className="page-head" style={{ marginBottom: 16 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          Decision
          <span className="mono" style={{ fontSize: 13, color: "var(--ink-muted)", fontWeight: 500 }}>
            <CopyId id={v.decisionId} />
          </span>
        </h2>
        <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Chip chip={outcomeChip(v)} />
          <Chip chip={verificationChip(v.proofVerification.reason)} />
          <Chip chip={paymentChip(v)} />
          <span style={{ color: "var(--ink-faint)" }}>· {formatTimestamp(v.ts)}</span>
        </p>
        {policyDigest ? (
          <p style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>Policy digest</span>
            <span className="pid" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <CopyId id={policyDigest} />
            </span>
          </p>
        ) : null}
      </div>

      {v.corrupt ? (
        <div className="state-card bad" role="alert" style={{ marginBottom: 20, textAlign: "left", padding: "14px 16px" }}>
          <strong>Corrupt record.</strong> At least one stored blob for this decision failed
          to parse or validate. The bridge surfaces it honestly rather than hiding it — treat
          any parsed field below as suspect.
        </div>
      ) : null}

      {/* PRIMARY: the six-stage execution timeline, trust ladder folded in. */}
      <Section
        title="Execution timeline"
        sub="The full lifecycle of this spend, top to bottom — every stage's state derived only from what the audit trail records. Each id/digest is copyable."
      >
        <Timeline v={v} />
      </Section>

      <div className="grid two">
        <Section title="Purchase request" sub="The structured spend request the agent submitted (untrusted input).">
          <dl className="kv">
            <Row k="Agent">{v.agentId}</Row>
            <Row k="Vendor">{v.vendorId}</Row>
            <Row k="Amount">{formatMoney(v.amount, currency)}</Row>
            <Row k="Category">{v.category}</Row>
            {v.request?.invoiceRef ? <Row k="Invoice">{v.request.invoiceRef}</Row> : null}
            <Row k="Request id">
              <span className="mono">{v.requestId}</span>
            </Row>
          </dl>
        </Section>

        <Section title="Fired rules" sub="Every policy rule the deterministic kernel fired — stored verbatim, with its meaning.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            <Chip chip={outcomeChip(v)} />
            {v.kernelId ? <span className="rule-tag">kernel · {v.kernelId}</span> : null}
          </div>
          {v.firedRules.length > 0 ? (
            <div className="cell-rules" style={{ marginBottom: 10 }}>
              {v.firedRules.map((r) => (
                <span key={r} className="rule-tag" title={ruleBlurb(r)}>
                  {ruleTitle(r)}
                </span>
              ))}
            </div>
          ) : (
            <p className="card-sub" style={{ margin: 0 }}>No rules fired.</p>
          )}
          {v.decision && v.decision.reasons.length > 0 ? (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--ink-muted)", fontSize: 13 }}>
              {v.decision.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title="Provenance" sub="How the decision was produced — a readable flow, derived from trusted context (never agent-supplied).">
          <ProvenanceFlow view={v} />
        </Section>

        <Section title="Trusted facts" sub="The authoritative facts the kernel evaluated — from the ledger + registry, not model narration.">
          {facts ? (
            <dl className="kv">
              <Row k="Vendor verified">{facts.vendor_verified ? "yes" : "no"}</Row>
              <Row k="Per-txn cap">{formatMoney(facts.per_txn_cap, currency)}</Row>
              <Row k="Daily limit">{formatMoney(facts.daily_limit, currency)}</Row>
              <Row k="Spent today">{formatMoney(facts.daily_total_so_far, currency)}</Row>
              <Row k="Approved categories">{facts.approved_categories.join(", ") || "—"}</Row>
              <Row k="Agent cleared for">{facts.agent_cleared_categories.join(", ") || "—"}</Row>
              <Row k="Attestation">{facts.attestation_present ? "present" : "absent"}</Row>
            </dl>
          ) : (
            <p className="card-sub" style={{ margin: 0 }}>No facts were recorded for this row.</p>
          )}
        </Section>

        <Section title="Proof" sub="Tamper-evident proof, independently recomputed on every read — never trusted from stored bytes.">
          <div className="proof-box">
            <dl className="kv">
              <Row k="Verification">
                <Chip chip={verificationChip(v.proofVerification.reason)} />
              </Row>
              <Row k="Proof id">
                {v.proof ? <span className="pid"><CopyId id={v.proof.proofId} /></span> : "—"}
              </Row>
              <Row k="Policy digest">
                {v.proof?.policyDigest ? <span className="pid"><CopyId id={v.proof.policyDigest} /></span> : "—"}
              </Row>
              <Row k="Request digest">
                {v.proof?.requestDigest ? <span className="pid"><CopyId id={v.proof.requestDigest} /></span> : "—"}
              </Row>
              <Row k="Facts digest">
                {v.proof?.factsDigest ? <span className="pid"><CopyId id={v.proof.factsDigest} /></span> : "—"}
              </Row>
              <Row k="Attestation">{v.proof?.attestationStatus ?? "—"}</Row>
              <Row k="Kernel">{v.proof?.kernelId ?? v.kernelId ?? "—"}</Row>
            </dl>
          </div>
        </Section>

        <Section title="Payment · sandbox receipt" sub="What the sandbox executor did. No real money moves; a failed receipt is never shown as settled.">
          {v.execution ? (
            <div className="proof-box">
              <dl className="kv">
                <Row k="Status">
                  <Chip chip={paymentChip(v)} />
                </Row>
                <Row k="Receipt id">
                  <span className="pid"><CopyId id={v.execution.receiptId} /></span>
                </Row>
                <Row k="Execution id">
                  <span className="mono">{v.execution.executionId}</span>
                </Row>
                <Row k="Provider">{v.execution.provider} (sandbox)</Row>
                <Row k="Executed">{formatTimestamp(v.execution.executedAt)}</Row>
              </dl>
            </div>
          ) : (
            <p className="card-sub" style={{ margin: 0 }}>
              {v.outcome === "deny"
                ? "No payment — the request was blocked by policy, so the executor was never called."
                : "No sandbox execution was recorded for this row (e.g. a gate-only policy check)."}
            </p>
          )}
        </Section>
      </div>
    </>
  );
}

export function DecisionDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const state = useAsync((signal) => fetchDecision(id ?? "", signal), [id]);

  useEffect(() => {
    document.title = `Decision · Provable Agent Spend`;
  }, []);

  if (state.status === "loading") {
    return (
      <>
        <Skeleton className="sk-line" style={{ width: 120 }} />
        <Skeleton style={{ height: 90, margin: "16px 0" }} />
        <div className="grid two">
          <Skeleton style={{ height: 180 }} />
          <Skeleton style={{ height: 180 }} />
        </div>
      </>
    );
  }
  if (state.status === "error") {
    return <BridgeErrorState error={state.error} onRetry={state.reload} />;
  }
  if (!id) {
    return (
      <StateCard icon="❔" title="No decision id">
        This route needs a decision id.
      </StateCard>
    );
  }
  return <DetailBody v={state.data} />;
}

export default DecisionDetail;

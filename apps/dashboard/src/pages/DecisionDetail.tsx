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
 * into the full record: the purchase request, the policy outcome + fired rules,
 * the trusted facts, the provenance flow, the tamper-evident proof + its
 * INDEPENDENT verification, and the sandbox payment receipt. The trust ladder up
 * top makes the four claims explicit and separable: the decision was allowed,
 * the audit was persisted, the proof re-verified, the payment executed — each
 * shown honestly (a deny or an unexecuted allow is not dressed up as success).
 */

type TrustState = "ok" | "bad" | "skip";
interface TrustStep {
  label: string;
  sub: string;
  state: TrustState;
}

const MARK: Record<TrustState, string> = { ok: "✓", bad: "✕", skip: "–" };

function trustLadder(v: DecisionView): TrustStep[] {
  // 1. Decision allowed
  const decisionStep: TrustStep =
    v.outcome === "allow"
      ? { label: "Decision allowed", sub: "policy allowed the spend", state: "ok" }
      : v.outcome === "deny"
        ? { label: "Decision denied", sub: "blocked by policy", state: "skip" }
        : { label: "No decision", sub: "infrastructure error row", state: "bad" };

  // 2. Audit persisted
  const auditStep: TrustStep = v.corrupt
    ? { label: "Audit corrupt", sub: "a stored record failed to parse", state: "bad" }
    : { label: "Audit persisted", sub: "recorded in the append-only ledger", state: "ok" };

  // 3. Proof verified (independent recompute)
  const reason = v.proofVerification.reason;
  const proofStep: TrustStep =
    reason === "ok"
      ? { label: "Proof verified", sub: "recomputed, matches — untampered", state: "ok" }
      : reason === "mismatch"
        ? { label: "Proof tampered", sub: "recomputes to a different id", state: "bad" }
        : reason === "corrupt"
          ? { label: "Proof corrupt", sub: "stored proof is malformed", state: "bad" }
          : { label: "No proof", sub: "none stored for this row", state: "skip" };

  // 4. Payment executed
  const paymentStep: TrustStep = v.execution
    ? v.execution.status === "settled"
      ? { label: "Payment executed", sub: `sandbox settled · ${v.execution.provider}`, state: "ok" }
      : { label: "Payment failed", sub: "executor returned a failed receipt", state: "bad" }
    : v.outcome === "deny"
      ? { label: "Payment blocked", sub: "executor never called", state: "skip" }
      : { label: "Not executed", sub: "no sandbox execution recorded", state: "skip" };

  return [decisionStep, auditStep, proofStep, paymentStep];
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
  const ladder = trustLadder(v);
  const facts = v.facts;

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
      </div>

      {v.corrupt ? (
        <div className="state-card bad" role="alert" style={{ marginBottom: 20, textAlign: "left", padding: "14px 16px" }}>
          <strong>Corrupt record.</strong> At least one stored blob for this decision failed
          to parse or validate. The bridge surfaces it honestly rather than hiding it — treat
          any parsed field below as suspect.
        </div>
      ) : null}

      {/* The four separable trust claims. */}
      <div className="trust-strip">
        {ladder.map((s) => (
          <div key={s.label} className={`trust-step ${s.state}`}>
            <div className="t-top">
              <span className="t-mark" aria-hidden="true">
                {MARK[s.state]}
              </span>
              <span className="t-label">{s.label}</span>
            </div>
            <div className="t-sub">{s.sub}</div>
          </div>
        ))}
      </div>

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

        <Section title="Policy outcome" sub="The deterministic kernel's verdict and every rule that fired — stored verbatim.">
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
              <Row k="Proof id">
                {v.proof ? <span className="pid"><CopyId id={v.proof.proofId} /></span> : "—"}
              </Row>
              <Row k="Verification">
                <Chip chip={verificationChip(v.proofVerification.reason)} />
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
                : "No sandbox execution was recorded for this row (e.g. a gate-only hook check)."}
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

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { fetchDecisions } from "../lib/bridge.js";
import { useAsync } from "../lib/useAsync.js";
import type { DecisionView } from "../lib/types.js";
import {
  formatMoney,
  formatRelative,
  formatTimestamp,
  outcomeChip,
  paymentChip,
  verificationChip,
  explainDecision,
} from "../lib/format.js";
import { recentDecisions, lastUpdatedLabel } from "../lib/activity.js";
import { BridgeErrorState, Chip, Skeleton, StateCard } from "../components/ui.js";
import StatTile from "../components/StatTile.js";

/**
 * @ramp/dashboard — Overview (landing)
 *
 * The 10-second pitch for Provable Agent Spend followed by honest, live
 * indicators computed from the append-only ledger. No fabricated data: every
 * number below is counted from the decisions the read-only bridge actually
 * serves, and nothing is shown when the bridge is down.
 */

interface Counts {
  total: number;
  allowed: number;
  denied: number;
  verified: number;
  flagged: number;
}

function isFlagged(d: DecisionView): boolean {
  const reason = d.proofVerification.reason;
  return (
    d.corrupt === true ||
    reason === "mismatch" ||
    reason === "corrupt" ||
    d.execution?.status === "failed"
  );
}

function tally(decisions: readonly DecisionView[]): Counts {
  let allowed = 0;
  let denied = 0;
  let verified = 0;
  let flagged = 0;
  for (const d of decisions) {
    if (d.outcome === "allow") allowed += 1;
    if (d.outcome === "deny") denied += 1;
    if (d.proofVerification.reason === "ok") verified += 1;
    if (isFlagged(d)) flagged += 1;
  }
  return { total: decisions.length, allowed, denied, verified, flagged };
}

const WORKFLOW: readonly string[] = [
  "Agent request",
  "Policy",
  "Proof",
  "Ledger",
  "Payment",
  "Receipt",
];

/** One entry in the Recent Activity strip — links to the full provenance view. */
function ActivityRow({ v, now, first }: { v: DecisionView; now: Date; first: boolean }): JSX.Element {
  const to = `/decisions/${encodeURIComponent(v.decisionId)}`;
  const currency = v.request?.currency ?? "USD";
  return (
    <Link
      to={to}
      style={{
        display: "block",
        padding: "12px 0",
        borderTop: first ? undefined : "1px solid var(--border)",
        color: "inherit",
        textDecoration: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="mono">{v.agentId}</span>
          <span aria-hidden="true" style={{ color: "var(--ink-faint)" }}>→</span>
          <span className="mono">{v.vendorId}</span>
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {formatMoney(v.amount, currency)}
          </span>
        </div>
        <span
          style={{ fontSize: 12, color: "var(--ink-faint)" }}
          title={formatTimestamp(v.ts)}
        >
          {formatRelative(v.ts, now)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 6px" }}>
        <Chip chip={outcomeChip(v)} />
        <Chip chip={verificationChip(v.proofVerification.reason)} />
        <Chip chip={paymentChip(v)} />
      </div>
      <p className="card-sub" style={{ margin: 0 }}>
        {explainDecision(v)}
      </p>
    </Link>
  );
}

/**
 * Recent Activity — the five most recent LIVE decisions from the read-only
 * bridge. Every state (loading / empty / bridge failure / data) is rendered with
 * the shared honest primitives; selection + ordering live in `activity.ts`.
 */
function RecentActivity(): JSX.Element {
  const state = useAsync((signal) => fetchDecisions({ limit: 5 }, signal), []);

  // Honest "last updated" — captured when the fetch actually resolved, and
  // recomputed against the current clock on each render (no fake ticking).
  const data = state.status === "success" ? state.data : null;
  const [resolvedAt, setResolvedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (data) setResolvedAt(new Date());
  }, [data]);

  const now = new Date();
  const rows = data ? recentDecisions(data.decisions, 5) : [];

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3>Recent activity</h3>
          <p className="card-sub" style={{ margin: 0 }}>
            The five most recent decisions from the append-only ledger.
          </p>
        </div>
        {resolvedAt ? (
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            {lastUpdatedLabel(resolvedAt, now)}
          </span>
        ) : null}
      </div>

      <div style={{ marginTop: 12 }}>
        {state.status === "loading" ? (
          <div className="table-wrap">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="sk-row" />
            ))}
          </div>
        ) : state.status === "error" ? (
          <BridgeErrorState error={state.error} onRetry={state.reload} />
        ) : rows.length === 0 ? (
          <StateCard icon="⚖" title="No decisions yet">
            Trigger a payment through the MCP <code>pay_vendor</code> tool and the
            newest decisions stream in here with full provenance.
          </StateCard>
        ) : (
          <div>
            {rows.map((v, i) => (
              <ActivityRow key={v.decisionId} v={v} now={now} first={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Overview(props: { onHealth?: () => void }): JSX.Element {
  const state = useAsync(
    (signal) => fetchDecisions({ limit: 200 }, signal),
    [],
  );

  const settled = state.status === "success" || state.status === "error";
  const onHealth = props.onHealth;
  useEffect(() => {
    if (settled) onHealth?.();
  }, [settled, onHealth]);

  useEffect(() => {
    document.title = "Overview · Provable Agent Spend";
  }, []);

  const counts = state.status === "success" ? tally(state.data.decisions) : null;
  const truncated =
    state.status === "success" && state.data.nextCursor !== undefined;
  const decisionsHint = truncated ? "latest 200" : undefined;
  const empty = counts !== null && counts.total === 0;

  return (
    <div className="grid">
      <section className="hero">
        <h2>The trust layer between AI agents and money.</h2>
        <p className="lede">
          Every autonomous purchase is <strong>policy-controlled</strong>,{" "}
          <strong>recorded</strong>, <strong>traceable</strong>, and{" "}
          <strong>independently verifiable</strong>. This console reads the
          append-only audit trail — no fabricated data.
        </p>
      </section>

      <div className="workflow" aria-label="How a purchase flows through the system">
        {WORKFLOW.map((label, i) => (
          <div className="wf-step" key={label}>
            <span className="n">{String(i + 1).padStart(2, "0")}</span>
            {label}
            {i < WORKFLOW.length - 1 ? (
              <span className="wf-arrow" aria-hidden="true">
                →
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {state.status === "error" ? (
        <BridgeErrorState error={state.error} onRetry={state.reload} />
      ) : (
        <div className="kpi-row">
          <StatTile
            label="Decisions"
            value={counts?.total}
            hint={decisionsHint}
            tone="neutral"
          />
          <StatTile
            label="Allowed"
            value={counts?.allowed}
            hint="policy allow"
            tone="accent"
          />
          <StatTile label="Denied" value={counts?.denied} tone="deny" />
          <StatTile
            label="Proofs valid"
            value={counts?.verified}
            hint="independently recomputed"
            tone="accent"
          />
          <StatTile
            label="Failed / corrupt"
            value={counts?.flagged}
            hint="not settled"
            tone="warn"
          />
        </div>
      )}

      {empty ? (
        <div className="card">
          <p className="card-sub">
            No decisions yet — trigger a <code>pay_vendor</code> call and they
            appear here.
          </p>
        </div>
      ) : null}

      <RecentActivity />

      <div className="card">
        <h3>How a purchase is proven</h3>
        <p className="card-sub">
          Authoritative facts about the agent, vendor, and request are gathered
          first. A deterministic policy kernel — not a prompt — decides allow or
          deny. Before any money moves, a tamper-evident proof of that decision
          is persisted. An independent verifier recomputes the proof to confirm
          nothing was altered, and only then does the sandbox settle the payment.
          Every step is written to the append-only ledger you are reading now.
        </p>
      </div>
    </div>
  );
}

export default Overview;

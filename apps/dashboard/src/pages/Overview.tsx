import { useEffect } from "react";
import type { JSX } from "react";
import { fetchDecisions } from "../lib/bridge.js";
import { useAsync } from "../lib/useAsync.js";
import type { DecisionView } from "../lib/types.js";
import { BridgeErrorState } from "../components/ui.js";
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
            label="Proofs verified"
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

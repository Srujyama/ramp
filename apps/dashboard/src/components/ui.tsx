/**
 * @ramp/dashboard — shared UI primitives
 *
 * Small, presentational building blocks shared across screens: status chips,
 * the persistent sandbox banner, loading skeletons, honest error/empty states
 * (including the four bridge failure modes), the provenance flow, and a
 * copy-to-clipboard id. No data fetching here.
 */
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import type { StatusChip } from "../lib/format.js";
import { decisionFlow } from "../lib/provenance.js";
import { BridgeError } from "../lib/bridge.js";
import type { DecisionView } from "../lib/types.js";

/** A semantic status chip (allow/deny/verified/settled/…). */
export function Chip({ chip }: { chip: StatusChip }): JSX.Element {
  return (
    <span className={`chip ${chip.tone}`} title={chip.title}>
      <span className="cdot" aria-hidden="true" />
      {chip.label}
    </span>
  );
}

/** Persistent, unmissable "this is a sandbox" banner. */
export function SandboxBanner(): JSX.Element {
  return (
    <div className="sandbox-banner" role="note">
      <span className="dot" aria-hidden="true" />
      Sandbox mode — no real money moves.
      <span className="muted">Amounts and receipts are simulated for the demo.</span>
    </div>
  );
}

export function SkipLink(): JSX.Element {
  return (
    <a className="skip-link" href="#main">
      Skip to content
    </a>
  );
}

/** A generic state card (empty / error / disconnected). */
export function StateCard({
  icon,
  title,
  children,
  bad,
  onRetry,
}: {
  icon: string;
  title: string;
  children: ReactNode;
  bad?: boolean;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className={`state-card${bad ? " bad" : ""}`} role={bad ? "alert" : undefined}>
      <div className="s-icon" aria-hidden="true">
        {icon}
      </div>
      <h4>{title}</h4>
      <p>{children}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Render a fetch failure as the right honest state, keyed on BridgeError.kind. */
export function BridgeErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): JSX.Element {
  if (error instanceof BridgeError && error.kind === "unavailable") {
    return (
      <StateCard icon="⚡" title="Ledger bridge unavailable" bad onRetry={onRetry}>
        The dashboard couldn&apos;t reach the read-only audit bridge. Start it with{" "}
        <code>pnpm --filter @ramp/ledger bridge</code> and confirm the URL.
      </StateCard>
    );
  }
  if (error instanceof BridgeError && error.kind === "malformed") {
    return (
      <StateCard icon="⚠" title="Unexpected response" bad onRetry={onRetry}>
        The bridge answered, but the response wasn&apos;t the shape the dashboard
        expects. It may be a version mismatch.
      </StateCard>
    );
  }
  if (error instanceof BridgeError && error.kind === "not_found") {
    return (
      <StateCard icon="❔" title="Decision not found" onRetry={onRetry}>
        No decision with that id is in the audit trail.
      </StateCard>
    );
  }
  return (
    <StateCard icon="⚠" title="Something went wrong" bad onRetry={onRetry}>
      {error instanceof Error ? error.message : "Unknown error reading the ledger."}
    </StateCard>
  );
}

/** Shimmering skeleton block. */
export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

/** The provenance DAG rendered as a readable 5-step flow. */
export function ProvenanceFlow({ view }: { view: DecisionView }): JSX.Element {
  const steps = decisionFlow(view);
  return (
    <ol className="flow">
      {steps.map((s) => (
        <li key={s.key}>
          <span className={`node ${s.tone}`} aria-hidden="true" />
          <div className="f-title">{s.title}</div>
          <div className="f-detail">{s.detail}</div>
          {s.sources && s.sources.length > 0 ? (
            <div className="f-sources">
              {s.sources.map((src) => (
                <span key={src} className="rule-tag">
                  {src}
                </span>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** A monospace id with click-to-copy. */
export function CopyId({ id, label }: { id: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="id-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title="Copy to clipboard"
    >
      {label ?? id}
      {copied ? " ✓" : ""}
    </button>
  );
}

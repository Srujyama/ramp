import type { JSX, ReactNode } from "react";

/**
 * @ramp/dashboard — StatTile
 *
 * A presentational KPI tile. Phase 0 ships with NO real data: `value` is
 * optional and, when absent, renders an honest monospace "—" placeholder so
 * the shell never fabricates numbers. `tone` maps to a semantic accent dot
 * (verification-green ALLOW, deny-red, warn-amber, info-blue).
 */
export type StatTone = "neutral" | "accent" | "deny" | "warn" | "info";

export interface StatTileProps {
  /** Short metric label, e.g. "Decisions today". */
  label: string;
  /** The metric value. Omit to render the "no data yet" placeholder. */
  value?: ReactNode;
  /** Optional sub-hint under the value, e.g. "vs. daily limit". */
  hint?: string;
  /** Semantic accent for the tile's status dot. */
  tone?: StatTone;
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: StatTileProps): JSX.Element {
  const toneClass = tone === "neutral" ? "" : ` ${tone}`;
  return (
    <div className={`stat-tile${toneClass}`}>
      <div className="st-label">
        <span className="st-dot" />
        {label}
      </div>
      {value === undefined ? (
        <div className="st-value placeholder" aria-label="no data yet">
          —
        </div>
      ) : (
        <div className="st-value">{value}</div>
      )}
      {hint ? <div className="st-hint">{hint}</div> : null}
    </div>
  );
}

export default StatTile;

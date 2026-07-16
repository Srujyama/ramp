import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { AgentSummary } from "../lib/agents.js";
import { maskedCardNumber, vendorLabel } from "../lib/identity.js";
import { formatMoney } from "../lib/format.js";
import { cn } from "../lib/utils.js";

/**
 * The signature element: an agent's clearances + spend limits + rolled-up
 * analytics, presented as a virtual corporate card. Everything on it is real
 * — derived from lib/agents.ts, which is itself derived only from decisions
 * this agent actually made. The card face keeps a fixed dark identity across
 * both app themes (see --cardface in index.css) so it reads as an object,
 * not another themed panel. Clickable: opens the agent's full detail page.
 *
 * The "$X / $Y today" figure is asymmetric on purpose: the NUMERATOR is
 * derived settled spend (money that moved), the DENOMINATOR is the policy
 * limit copied from recorded facts (config). Without a recorded limit there is
 * no denominator to show, so the bar is omitted rather than guessed.
 */
export function AgentCard({
  agent,
  className,
  linked = true,
}: {
  agent: AgentSummary;
  className?: string;
  /** Set false on the agent's own detail page — a self-link is dead weight there. */
  linked?: boolean;
}): JSX.Element {
  // Numerator: always derived, always known (0 = nothing settled today).
  // Denominator: policy config, which may genuinely be unobserved.
  const spentToday = agent.dailyTotalSoFar;
  const dailyLimit = agent.dailyLimit;
  const pct = dailyLimit !== null && dailyLimit > 0 ? spentToday / dailyLimit : null;
  const over = pct !== null && pct > 1;
  const barTone = over ? "bg-chart-deny" : pct !== null && pct >= 0.85 ? "bg-chart-escalate" : "bg-lime";

  const hasProofHistory = agent.decisionCount > 0;
  const allVerified = hasProofHistory && agent.flaggedCount === 0;

  const containerClass = cn(
    "group flex flex-col gap-4 rounded-2xl bg-cardface p-5 text-cardface-ink shadow-card",
    "ring-1 ring-inset ring-cardface-ring",
    linked &&
      "transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:-translate-y-0.5 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2",
    className,
  );

  const content: ReactNode = (
    <>
      <div className="flex items-start justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cardface-ink-muted">
          Agent card
        </span>
        {hasProofHistory ? (
          <span
            className={cn(
              "flex items-center gap-1 text-[11px] font-medium",
              allVerified ? "text-lime" : "text-chart-escalate",
            )}
            title={`${agent.proofValidCount}/${agent.decisionCount} proofs independently verified`}
          >
            {allVerified ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
            {agent.proofValidCount}/{agent.decisionCount} verified
          </span>
        ) : (
          <span className="text-[11px] text-cardface-ink-muted">No activity</span>
        )}
      </div>

      <div>
        <div className="truncate text-[15px] font-semibold">{agent.label}</div>
        <div className="mt-0.5 font-mono text-[11px] tracking-wide text-cardface-ink-muted">
          {maskedCardNumber(agent.agentId)}
        </div>
      </div>

      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="tabular text-[26px] font-semibold leading-none">
            {formatMoney(spentToday, "USD")}
          </span>
          <span className="text-[12px] text-cardface-ink-muted">
            {dailyLimit !== null ? <>/ {formatMoney(dailyLimit, "USD")} today</> : "settled today"}
          </span>
        </div>
        {pct !== null ? (
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-cardface-2">
            <div
              className={cn("h-full origin-left rounded-full transition-transform duration-300", barTone)}
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, pct))})`, width: "100%" }}
            />
          </div>
        ) : null}
      </div>

      {agent.clearedCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {agent.clearedCategories.map((c) => (
            <span key={c} className="rounded-full bg-cardface-2 px-2 py-0.5 text-[10.5px] text-cardface-ink-muted">
              {c.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-cardface-line pt-3 text-[11.5px] text-cardface-ink-muted">
        <span>
          {agent.vendorsUsed} vendor{agent.vendorsUsed === 1 ? "" : "s"}
        </span>
        {agent.topVendor ? (
          <span className="truncate">
            Top: <span className="text-cardface-ink">{vendorLabel(agent.topVendor.vendorId)}</span>
          </span>
        ) : null}
      </div>
    </>
  );

  if (!linked) {
    return <div className={containerClass}>{content}</div>;
  }
  return (
    <Link to={`/app/agents/${encodeURIComponent(agent.agentId)}`} className={containerClass}>
      {content}
    </Link>
  );
}

export default AgentCard;

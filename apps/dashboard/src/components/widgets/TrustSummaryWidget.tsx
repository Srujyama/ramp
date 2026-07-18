import type { JSX } from "react";
import { ShieldCheck, ShieldAlert, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import type { DecisionView } from "../../lib/types.js";

function isFlagged(d: DecisionView): boolean {
  const reason = d.proofVerification.reason;
  return d.corrupt === true || reason === "mismatch" || reason === "corrupt" || d.execution?.status === "failed";
}

export function TrustSummaryWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const total = decisions.length;
  const verified = decisions.filter((d) => d.proofVerification.reason === "ok").length;
  const flagged = decisions.filter(isFlagged).length;
  const needsApproval = decisions.filter((d) => d.outcome === "escalate").length;
  const pct = total > 0 ? Math.round((verified / total) * 100) : null;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Proof verification</CardTitle>
          <CardDescription>Independently recomputed, not trusted from stored bytes</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-lime-soft text-lime-ink">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <div className="tabular text-[22px] font-semibold leading-none text-ink">
              {pct !== null ? `${pct}%` : "…"}
            </div>
            <div className="text-[12px] text-ink-faint">
              {total > 0 ? `${verified} of ${total} proofs verified` : "No decisions yet"}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2.5">
          <span className="flex items-center gap-2 text-[13px] text-ink-muted">
            <ShieldAlert className="size-4 text-chart-deny" />
            Flagged records
          </span>
          <span className="tabular text-[13px] font-semibold text-ink">{flagged}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2.5">
          <span className="flex items-center gap-2 text-[13px] text-ink-muted">
            <Clock className="size-4 text-chart-escalate" />
            Needs human approval
          </span>
          <span className="tabular text-[13px] font-semibold text-ink">{needsApproval}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default TrustSummaryWidget;

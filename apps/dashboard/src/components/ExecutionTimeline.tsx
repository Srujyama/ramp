import type { JSX } from "react";
import { buildTimeline, type StageState } from "../lib/timeline.js";
import { outcomeChip, verificationChip, paymentChip, type StatusChip as StatusChipModel } from "../lib/format.js";
import type { DecisionView } from "../lib/types.js";
import { cn } from "../lib/utils.js";
import { CopyId } from "./ui/copy-id.js";
import { StatusChip } from "./StatusChip.js";

const DOT_TONE: Record<StageState, string> = {
  done: "bg-lime",
  blocked: "bg-amber",
  failed: "bg-flag",
  corrupt: "bg-flag",
  skipped: "bg-ink-faint",
  pending: "bg-info",
};

const PILL: Record<StageState, { label: string; className: string }> = {
  done: { label: "Done", className: "border-lime/40 text-lime-ink" },
  blocked: { label: "Blocked", className: "border-amber/40 text-amber-ink" },
  failed: { label: "Failed", className: "border-flag/40 text-flag-ink" },
  corrupt: { label: "Corrupt", className: "border-flag/40 text-flag-ink" },
  skipped: { label: "Skipped", className: "border-line-strong text-ink-faint" },
  pending: { label: "Pending", className: "border-info/40 text-info-ink" },
};

const META_LABEL: Record<string, string> = {
  request: "request",
  policy: "policy digest",
  decision: "decision",
  proof: "proof",
  payment: "settlement",
};

/** The trust-ladder chip folded into the relevant stage — no separate status cards. */
function stageChip(v: DecisionView, key: string): StatusChipModel | null {
  if (key === "policy") return outcomeChip(v);
  if (key === "proof") return verificationChip(v.proofVerification.reason);
  if (key === "payment") return paymentChip(v);
  return null;
}

/**
 * The primary decision-detail visualization: the full lifecycle top to bottom,
 * with the outcome/proof/payment chips folded into the stage they belong to
 * (so a deny reads "blocked" here, not as a separate red card floating above).
 */
export function ExecutionTimeline({ view }: { view: DecisionView }): JSX.Element {
  const stages = buildTimeline(view);
  return (
    <ol className="relative flex flex-col gap-6 pl-1">
      {stages.map((s, i) => {
        const chip = stageChip(view, s.key);
        return (
          <li key={s.key} className="relative flex gap-3.5">
            {i < stages.length - 1 ? (
              <span className="absolute left-[6px] top-4 h-[calc(100%+8px)] w-px bg-line" aria-hidden="true" />
            ) : null}
            <span
              className={cn("relative z-10 mt-1.5 size-[13px] shrink-0 rounded-full ring-4 ring-surface", DOT_TONE[s.state])}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold text-ink">{s.title}</span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    PILL[s.state].className,
                  )}
                >
                  {PILL[s.state].label}
                </span>
                {chip ? <StatusChip chip={chip} /> : null}
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">{s.detail}</p>
              {s.meta ? (
                <div className="mt-1.5 flex items-baseline gap-1.5">
                  <span className="text-[11px] text-ink-faint">{META_LABEL[s.key] ?? "id"}</span>
                  <CopyId id={s.meta} />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default ExecutionTimeline;

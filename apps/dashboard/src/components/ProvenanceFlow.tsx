import type { JSX } from "react";
import { decisionFlow } from "../lib/provenance.js";
import type { DecisionView } from "../lib/types.js";
import { cn } from "../lib/utils.js";
import type { Tone } from "../lib/format.js";

const DOT_TONE: Record<Tone, string> = {
  accent: "bg-lime",
  deny: "bg-flag",
  warn: "bg-amber",
  info: "bg-info",
  neutral: "bg-ink-faint",
};

/** How a decision was produced — a readable, trusted-derived flow with a connecting spine. */
export function ProvenanceFlow({ view }: { view: DecisionView }): JSX.Element {
  const steps = decisionFlow(view);
  return (
    <ol className="relative flex flex-col gap-5 pl-1">
      {steps.map((s, i) => (
        <li key={s.key} className="relative flex gap-3">
          {i < steps.length - 1 ? (
            <span className="absolute left-[5px] top-4 h-[calc(100%+4px)] w-px bg-line" aria-hidden="true" />
          ) : null}
          <span className={cn("relative z-10 mt-1 size-[11px] shrink-0 rounded-full ring-4 ring-surface", DOT_TONE[s.tone])} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-ink">{s.title}</div>
            <div className="text-[12.5px] text-ink-muted">{s.detail}</div>
            {s.sources && s.sources.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {s.sources.map((src) => (
                  <span key={src} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-ink-faint">
                    {src}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default ProvenanceFlow;

import { useState } from "react";
import type { JSX } from "react";
import { cn } from "../../lib/utils.js";
import { formatMoney } from "../../lib/format.js";

export interface StackedBarPoint {
  key: string;
  label: string;
  allow: number;
  escalate: number;
  deny: number;
  settledSpend: number;
}

/**
 * Daily decision volume, stacked by outcome (allow/escalate/deny — the
 * validated 3-color status trio in index.css: --chart-allow/-escalate/-deny).
 * Bars are rounded only at the top (anchored to the baseline), with a 2px
 * surface gap between stacked segments so adjacent outcomes never bleed
 * together. A per-bar hover tooltip surfaces the exact counts + settled spend.
 */
export function StackedBar({
  points,
  height = 160,
  className,
}: {
  points: readonly StackedBarPoint[];
  height?: number;
  className?: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.allow + p.escalate + p.deny));

  if (points.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center text-[13px] text-ink-faint", className)}
        style={{ height }}
      >
        No activity in this window.
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <div className="flex items-end justify-center gap-2" style={{ height }}>
        {points.map((p, i) => {
          const total = p.allow + p.escalate + p.deny;
          const scale = height / max;
          const allowH = p.allow * scale;
          const escalateH = p.escalate * scale;
          const denyH = p.deny * scale;
          const active = hover === i;
          return (
            <div
              key={p.key}
              className="group relative w-full max-w-12 flex-1"
              style={{ height }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            >
              <div
                className={cn(
                  "absolute bottom-0 flex w-full flex-col-reverse overflow-hidden rounded-t-[4px] transition-opacity",
                  active ? "opacity-100" : "opacity-90 group-hover:opacity-100",
                )}
                style={{ height: Math.max(total > 0 ? 3 : 0, allowH + escalateH + denyH) }}
              >
                {p.allow > 0 && (
                  <div style={{ height: allowH }} className="w-full bg-chart-allow" />
                )}
                {p.escalate > 0 && (
                  <>
                    {p.allow > 0 && <div className="h-[2px] w-full bg-surface" />}
                    <div style={{ height: escalateH }} className="w-full bg-chart-escalate" />
                  </>
                )}
                {p.deny > 0 && (
                  <>
                    {(p.allow > 0 || p.escalate > 0) && <div className="h-[2px] w-full bg-surface" />}
                    <div style={{ height: denyH }} className="w-full bg-chart-deny" />
                  </>
                )}
                {total === 0 && <div className="h-1 w-full rounded-full bg-surface-sunken" />}
              </div>

              {active && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-10 w-max -translate-x-1/2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-popover"
                >
                  <div className="font-medium text-ink">{p.label}</div>
                  <div className="tabular text-ink-muted">{formatMoney(p.settledSpend, "USD")} settled</div>
                  <div className="mt-0.5 flex gap-2 text-[11px]">
                    <span className="text-chart-allow">{p.allow} allowed</span>
                    {p.escalate > 0 && <span className="text-chart-escalate">{p.escalate} held</span>}
                    {p.deny > 0 && <span className="text-chart-deny">{p.deny} denied</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-center gap-2 text-[11px] text-ink-faint">
        {points.map((p) => (
          <span key={p.key} className="w-full max-w-12 flex-1 truncate text-center">
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

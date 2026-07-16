import * as React from "react";
import { cn } from "../../lib/utils.js";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0–1. Values above 1 render as an overflow (full bar, tone stays as passed). */
  value: number;
  tone?: "lime" | "amber" | "flag" | "info";
}

/**
 * A meter, not a decoration — used for spend-vs-limit and clearance usage.
 * `transform: scaleX()` only (compositor-only, no layout thrash).
 */
export function Progress({ value, tone = "lime", className, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(1, value));
  const bg =
    tone === "lime" ? "bg-lime" : tone === "amber" ? "bg-amber" : tone === "flag" ? "bg-flag" : "bg-info";
  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full bg-surface-sunken", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...props}
    >
      <div
        className={cn("h-full origin-left rounded-full transition-transform duration-300 ease-out", bg)}
        style={{ transform: `scaleX(${pct})`, width: "100%" }}
      />
    </div>
  );
}

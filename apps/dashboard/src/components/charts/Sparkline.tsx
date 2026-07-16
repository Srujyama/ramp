import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

/**
 * A single-series inline trend — the Agent Card's "recent activity" line.
 * Thin 2px stroke, no per-point markers except the terminal value (the
 * anatomy spec's "selective direct label", applied to the single point that
 * matters: where the trend stands right now).
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
}): JSX.Element {
  if (values.length < 2) {
    return <div style={{ width, height }} className={className} aria-hidden="true" />;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 3;

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)}>
      <path d={path} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="stroke-lime" />
      {last ? <circle cx={last[0]} cy={last[1]} r={2.5} className="fill-lime" /> : null}
    </svg>
  );
}

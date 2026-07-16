import type { JSX } from "react";
import { formatMoney } from "../../lib/format.js";

/**
 * Half-circle arc gauge for "spend vs. limit" — an Agent Card's daily usage
 * and the Policy page's org-wide daily limit. Color is a real status
 * encoding (on track / near limit / over limit), so it's the one place a
 * gauge legitimately draws from the validated chart-status trio rather than
 * the sequential donut ramp.
 */
export function Gauge({
  value,
  limit,
  currency = "USD",
  size = 128,
  label,
}: {
  value: number;
  limit: number;
  currency?: string;
  size?: number;
  label?: string;
}): JSX.Element {
  const pct = limit > 0 ? value / limit : 0;
  const clamped = Math.max(0, Math.min(1, pct));
  const over = pct > 1;
  const tone = over ? "var(--chart-deny)" : pct >= 0.85 ? "var(--chart-escalate)" : "var(--chart-allow)";

  const stroke = size * 0.14;
  const r = (size - stroke) / 2;
  const circumference = Math.PI * r; // half circle
  const dash = clamped * circumference;

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size / 2 + stroke / 2} viewBox={`0 0 ${size} ${size / 2 + stroke / 2}`}>
        <path
          d={`M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="stroke-surface-sunken"
        />
        <path
          d={`M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          style={{ stroke: tone, transition: "stroke-dasharray 300ms ease-out" }}
        />
      </svg>
      <div className="-mt-3 flex flex-col items-center">
        <div className="tabular text-[19px] font-semibold text-ink">{Math.round(pct * 100)}%</div>
        <div className="tabular text-[11px] text-ink-faint">
          {formatMoney(value, currency)} / {formatMoney(limit, currency)}
        </div>
        {label ? <div className="mt-0.5 text-[11px] text-ink-faint">{label}</div> : null}
      </div>
    </div>
  );
}

import { useState } from "react";
import type { JSX } from "react";
import { formatMoney } from "../../lib/format.js";

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
}

/**
 * A ranked breakdown (top vendors/categories by spend), not unordered
 * category identity — so it draws from a single-hue SEQUENTIAL ramp
 * (dominant slice darkest -> smallest lightest) rather than a categorical
 * rainbow. Keeps the one-accent-with-intention rule: this widget is
 * supporting, not the hero, so it borrows the brand hue instead of adding a
 * second palette. Caps at 5 named slices; the rest fold into "Other" (a
 * neutral, never a 6th hue) per the anti-pattern this skill warns against.
 */
const RAMP_LIGHT = ["#3d6519", "#5c8b26", "#7fb239", "#a3cf6f", "#c8e3a5"];
const RAMP_DARK = ["#bee68c", "#9fd066", "#7fb63f", "#5f9c2c", "#487624"];
const OTHER_LIGHT = "#d7dae3";
const OTHER_DARK = "#333a44";

function fold(slices: readonly DonutSlice[], cap: number): DonutSlice[] {
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  if (sorted.length <= cap) return sorted;
  const head = sorted.slice(0, cap - 1);
  const restTotal = sorted.slice(cap - 1).reduce((sum, s) => sum + s.value, 0);
  return [...head, { key: "__other__", label: "Other", value: restTotal }];
}

export function Donut({
  slices,
  size = 132,
  currency = "USD",
}: {
  slices: readonly DonutSlice[];
  size?: number;
  currency?: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const folded = fold(slices, 5);
  const total = folded.reduce((sum, s) => sum + s.value, 0);

  if (total <= 0) {
    return (
      <div className="flex items-center justify-center text-[13px] text-ink-faint" style={{ height: size }}>
        No spend yet.
      </div>
    );
  }

  const stroke = size * 0.22;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const gapDeg = folded.length > 1 ? 2 : 0; // 2px-equivalent visual gap between segments

  let cursor = 0;
  const segments = folded.map((s, i) => {
    const frac = s.value / total;
    const dash = Math.max(0, frac * circumference - gapDeg);
    const offset = -cursor * circumference;
    cursor += frac;
    const isOther = s.key === "__other__";
    return {
      ...s,
      dash,
      offset,
      colorLight: isOther ? OTHER_LIGHT : (RAMP_LIGHT[i] ?? OTHER_LIGHT),
      colorDark: isOther ? OTHER_DARK : (RAMP_DARK[i] ?? OTHER_DARK),
    };
  });

  const active = hover !== null ? segments[hover] : null;

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-surface-sunken" />
          {segments.map((s, i) => (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${s.dash} ${circumference - s.dash}`}
              strokeDashoffset={s.offset}
              strokeLinecap="butt"
              className="cursor-pointer transition-opacity"
              style={{
                stroke: `light-dark(${s.colorLight}, ${s.colorDark})`,
                opacity: hover === null || hover === i ? 1 : 0.35,
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="tabular text-[15px] font-semibold text-ink">
            {formatMoney(active ? active.value : total, currency)}
          </div>
          <div className="text-[11px] text-ink-faint">{active ? active.label : "Total"}</div>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {segments.map((s, i) => (
          <li
            key={s.key}
            className="flex min-w-0 cursor-pointer flex-col gap-0.5 text-[12.5px]"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: `light-dark(${s.colorLight}, ${s.colorDark})` }}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-ink-muted">{s.label}</span>
            </span>
            <span className="tabular pl-4 font-medium text-ink">{formatMoney(s.value, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

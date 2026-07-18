import { useMemo, useState } from "react";
import type { JSX } from "react";
import { SlidersHorizontal, RotateCcw, ArrowRight } from "lucide-react";
import type { DecisionOutcome, Facts } from "@ramp/shared";
import { referenceKernel } from "@ramp/gate/reference";
import { reclassify, type PolicyOverrides } from "@ramp/gate/reclassify";
import { formatMoney } from "../lib/format.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card.js";
import { Button } from "./ui/button.js";

type Replayable = { facts: Facts; outcome: DecisionOutcome; amount: number };

const DIALS: { key: keyof PolicyOverrides; label: string; max: (cur: number) => number; step: number }[] = [
  { key: "per_txn_cap", label: "Per-transaction cap", max: (c) => Math.max(2000, c * 2), step: 50 },
  { key: "daily_limit", label: "Daily limit", max: (c) => Math.max(5000, c * 2), step: 50 },
  { key: "escalation_threshold", label: "Escalation threshold", max: (c) => Math.max(2000, c * 2), step: 50 },
  { key: "velocity_limit", label: "Velocity limit", max: (c) => Math.max(20, c * 2), step: 1 },
];

interface Tally {
  before: Record<DecisionOutcome, number>;
  after: Record<DecisionOutcome, number>;
  moneyAllowedBefore: number;
  moneyAllowedAfter: number;
  moneyStoppedBefore: number;
  moneyStoppedAfter: number;
  changed: number;
  n: number;
}

const ZERO: Record<DecisionOutcome, number> = { allow: 0, escalate: 0, deny: 0 };

/**
 * Read-only policy what-if. Replays every recorded decision (that carries facts)
 * through the REAL kernel with one or more dials overridden — everything else held
 * fixed — and shows what a dial change WOULD have done to payments already seen.
 * Deterministic, side-effect-free, entirely in the browser. Retune for real on Admin.
 */
export function PolicyWhatIf({ decisions, currency }: { decisions: Replayable[]; currency: string }): JSX.Element | null {
  const current = decisions[0]?.facts;
  const [ov, setOv] = useState<PolicyOverrides>({});

  const dials = useMemo(() => {
    if (!current) return [];
    return DIALS.map((d) => ({
      ...d,
      current: current[d.key] as number,
      value: (ov[d.key] ?? (current[d.key] as number)) as number,
    }));
  }, [current, ov]);

  const t = useMemo<Tally | null>(() => {
    if (!current) return null;
    const before = { ...ZERO };
    const after = { ...ZERO };
    let mAB = 0,
      mAA = 0,
      mSB = 0,
      mSA = 0,
      changed = 0;
    for (const d of decisions) {
      let r;
      try {
        r = reclassify(d.facts, d.outcome, ov, referenceKernel);
      } catch {
        continue;
      }
      before[d.outcome]++;
      after[r.after]++;
      if (r.changed) changed++;
      if (d.outcome === "allow") mAB += d.amount;
      else mSB += d.amount;
      if (r.after === "allow") mAA += d.amount;
      else mSA += d.amount;
    }
    return { before, after, moneyAllowedBefore: mAB, moneyAllowedAfter: mAA, moneyStoppedBefore: mSB, moneyStoppedAfter: mSA, changed, n: decisions.length };
  }, [decisions, ov, current]);

  if (!current || !t) return null;
  const dirty = Object.keys(ov).length > 0 && dials.some((d) => d.value !== d.current);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Policy what-if</CardTitle>
          <CardDescription>
            Replay {t.n.toLocaleString()} recorded decisions under different dials. Deterministic, in your browser, nothing
            changes. Retune for real on Admin.
          </CardDescription>
        </div>
        {dirty ? (
          <Button variant="ghost" size="sm" onClick={() => setOv({})}>
            <RotateCcw className="size-3.5" /> Reset
          </Button>
        ) : (
          <SlidersHorizontal className="size-4 shrink-0 text-ink-faint" />
        )}
      </CardHeader>
      <CardContent className="grid gap-6 pt-4 lg:grid-cols-2">
        {/* the dials */}
        <div className="flex flex-col gap-4">
          {dials.map((d) => (
            <div key={d.key} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <label className="text-[12.5px] font-medium text-ink">{d.label}</label>
                <span className="tabular text-[13px] font-semibold text-ink">
                  {d.key === "velocity_limit" ? d.value : formatMoney(d.value, currency)}
                  {d.value !== d.current ? (
                    <span className="ml-1.5 text-[11px] font-normal text-ink-faint">
                      was {d.key === "velocity_limit" ? d.current : formatMoney(d.current, currency)}
                    </span>
                  ) : null}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={d.max(d.current)}
                step={d.step}
                value={d.value}
                onChange={(e) => setOv((o) => ({ ...o, [d.key]: Number(e.target.value) }))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-sunken accent-lime"
              />
            </div>
          ))}
        </div>

        {/* the outcome */}
        <div className="flex flex-col gap-4 lg:border-l lg:border-line lg:pl-6">
          <div className="flex flex-col gap-2">
            <OutcomeRow label="Allowed" tone="var(--chart-allow)" before={t.before.allow} after={t.after.allow} />
            <OutcomeRow label="Held" tone="var(--chart-escalate)" before={t.before.escalate} after={t.after.escalate} />
            <OutcomeRow label="Denied" tone="var(--chart-deny)" before={t.before.deny} after={t.after.deny} />
          </div>
          <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px]">
            <MoneyRow label="Money allowed" before={t.moneyAllowedBefore} after={t.moneyAllowedAfter} currency={currency} />
            <MoneyRow label="Money stopped" before={t.moneyStoppedBefore} after={t.moneyStoppedAfter} currency={currency} />
          </div>
          <p className="text-[12px] text-ink-faint">
            {dirty ? (
              <>
                <span className="font-semibold text-ink">{t.changed.toLocaleString()}</span> of {t.n.toLocaleString()}{" "}
                decisions would flip under these dials.
              </>
            ) : (
              "Move a dial to preview the impact on decisions already recorded."
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function OutcomeRow({ label, tone, before, after }: { label: string; tone: string; before: number; after: number }): JSX.Element {
  const delta = after - before;
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tone }} aria-hidden="true" />
      <span className="flex-1 text-ink-muted">{label}</span>
      <span className="tabular text-ink-faint">{before.toLocaleString()}</span>
      <ArrowRight className="size-3.5 text-ink-faint" />
      <span className="tabular w-12 text-right font-semibold text-ink">{after.toLocaleString()}</span>
      <span className={`tabular w-12 text-right text-[12px] ${delta === 0 ? "text-ink-faint" : delta > 0 ? "text-lime-ink" : "text-flag-ink"}`}>
        {delta === 0 ? "0" : delta > 0 ? `+${delta}` : delta}
      </span>
    </div>
  );
}

function MoneyRow({ label, before, after, currency }: { label: string; before: number; after: number; currency: string }): JSX.Element {
  const delta = after - before;
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="tabular text-ink-faint">{formatMoney(before, currency)}</span>
        <ArrowRight className="size-3.5 text-ink-faint" />
        <span className="tabular font-semibold text-ink">{formatMoney(after, currency)}</span>
        {delta !== 0 ? (
          <span className={`tabular text-[12px] ${delta > 0 ? "text-lime-ink" : "text-flag-ink"}`}>
            ({delta > 0 ? "+" : ""}
            {formatMoney(delta, currency)})
          </span>
        ) : null}
      </span>
    </div>
  );
}

export default PolicyWhatIf;

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { Card, CardContent, CardHeader } from "../ui/card.js";
import { Progress } from "../ui/progress.js";
import { StackedBar, type StackedBarPoint } from "../charts/StackedBar.js";
import { dailySpend, summarizeCategories, latestFacts } from "../../lib/rollups.js";
import { formatMoney } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";
import type { DecisionView } from "../../lib/types.js";

const WINDOW_DAYS = 7;
const MAX_CHIPS = 6;

function weekdayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(d);
}

/**
 * The dashboard's hero: this week's settled spend overlaid on the org's
 * weekly budget (daily_limit * 7, the real policy config — never a made-up
 * target), with the daily allow/hold/deny chart beneath it. Category chips
 * re-slice both the total and the chart to real per-category decisions; the
 * budget reference stays org-wide (there is no recorded per-category budget
 * on the wire, so one is never fabricated).
 */
export function SpendOverviewWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const [category, setCategory] = useState<string | null>(null);

  const categoryChips = useMemo(() => summarizeCategories(decisions).slice(0, MAX_CHIPS), [decisions]);
  const filtered = useMemo(
    () => (category ? decisions.filter((d) => d.category === category) : decisions),
    [decisions, category],
  );

  const points = dailySpend(filtered);
  const windowPoints = points.slice(-WINDOW_DAYS);
  const totalSettled = windowPoints.reduce((sum, p) => sum + p.settledSpend, 0);

  const facts = latestFacts(decisions);
  const weeklyBudget = facts && facts.daily_limit > 0 ? facts.daily_limit * WINDOW_DAYS : null;
  const fill = weeklyBudget !== null ? Math.min(1, totalSettled / weeklyBudget) : null;
  const over = weeklyBudget !== null && totalSettled > weeklyBudget;

  const bars: StackedBarPoint[] = windowPoints.map((p) => ({
    key: p.date,
    label: weekdayLabel(p.date),
    allow: p.allowed,
    escalate: p.escalated,
    deny: p.denied,
    settledSpend: p.settledSpend,
  }));

  return (
    <Card className="col-span-full">
      <CardHeader className="flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-display text-[15px] font-semibold text-ink">Weekly spend</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            Settled spend, last {windowPoints.length || WINDOW_DAYS} days{category ? ` · ${category.replace(/_/g, " ")}` : ""}
          </p>
        </div>
        {categoryChips.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCategory(null)}
              className={cn(
                "rounded-[--radius-sm] border px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                category === null
                  ? "border-ink bg-ink text-white"
                  : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
              )}
            >
              All
            </button>
            {categoryChips.map((c) => (
              <button
                key={c.category}
                type="button"
                onClick={() => setCategory((cur) => (cur === c.category ? null : c.category))}
                className={cn(
                  "rounded-[--radius-sm] border px-2.5 py-1 text-[11.5px] font-semibold capitalize transition-colors",
                  category === c.category
                    ? "border-ink bg-ink text-white"
                    : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
                )}
              >
                {c.category.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="tabular font-display text-hero text-ink">{formatMoney(totalSettled, "USD")}</div>
          <div className="flex gap-4 pb-1 text-[12px] text-ink-muted">
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-chart-allow" /> Allowed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-chart-escalate" /> Held
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-chart-deny" /> Denied
            </span>
          </div>
        </div>

        {weeklyBudget !== null && fill !== null ? (
          <div className="mt-3">
            <Progress value={fill} tone={over ? "flag" : fill >= 0.85 ? "amber" : "lime"} />
            <p className="mt-1.5 text-[12px] text-ink-faint">
              {over ? "Over" : "Of"} the {formatMoney(weeklyBudget, "USD")} weekly budget ({formatMoney(facts!.daily_limit, "USD")}/day org limit)
            </p>
          </div>
        ) : null}

        <div className="mt-6">
          <StackedBar points={bars} height={200} />
        </div>
      </CardContent>
    </Card>
  );
}

export default SpendOverviewWidget;

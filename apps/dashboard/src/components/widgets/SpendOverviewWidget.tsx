import type { JSX } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import { StackedBar, type StackedBarPoint } from "../charts/StackedBar.js";
import { dailySpend } from "../../lib/rollups.js";
import type { DecisionView } from "../../lib/types.js";

function weekdayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(d);
}

export function SpendOverviewWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const points = dailySpend(decisions);
  const last14 = points.slice(-14);
  const totalSettled = last14.reduce((sum, p) => sum + p.settledSpend, 0);
  const bars: StackedBarPoint[] = last14.map((p) => ({
    key: p.date,
    label: weekdayLabel(p.date),
    allow: p.allowed,
    escalate: p.escalated,
    deny: p.denied,
    settledSpend: p.settledSpend,
  }));

  return (
    <Card className="col-span-full lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Spend overview</CardTitle>
          <CardDescription>Decision volume by outcome, last {last14.length || 0} days</CardDescription>
        </div>
        <div className="text-right">
          <div className="tabular text-[22px] font-semibold text-ink">
            {new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
              totalSettled,
            )}
          </div>
          <div className="text-[11.5px] text-ink-faint">settled, in window</div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex gap-4 text-[12px] text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-chart-allow" /> Allowed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-chart-escalate" /> Held
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-chart-deny" /> Denied
          </span>
        </div>
        <StackedBar points={bars} height={180} />
      </CardContent>
    </Card>
  );
}

export default SpendOverviewWidget;

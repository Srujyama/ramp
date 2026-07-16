import type { JSX } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import { formatMoney } from "../../lib/format.js";
import type { DecisionView, Facts } from "../../lib/types.js";

/** The org-wide caps every agent's spend is checked against — from the most recent decision carrying facts. */
function latestFacts(decisions: readonly DecisionView[]): Facts | null {
  for (const d of decisions) {
    if (d.facts) return d.facts;
  }
  return null;
}

export function LimitUsageWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const facts = latestFacts(decisions);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Org policy limits</CardTitle>
          <CardDescription>What every agent's spend is checked against</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {facts === null ? (
          <p className="text-[13px] text-ink-muted">No decisions with recorded facts yet.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-[11.5px] text-ink-faint">Per-transaction cap</dt>
              <dd className="tabular mt-0.5 text-[19px] font-semibold text-ink">
                {formatMoney(facts.per_txn_cap, "USD")}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">Daily limit</dt>
              <dd className="tabular mt-0.5 text-[19px] font-semibold text-ink">
                {formatMoney(facts.daily_limit, "USD")}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">Approval threshold</dt>
              <dd className="tabular mt-0.5 text-[15px] font-medium text-ink">
                {formatMoney(facts.escalation_threshold, "USD")}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">Approved categories</dt>
              <dd className="mt-0.5 text-[15px] font-medium text-ink">{facts.approved_categories.length}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export default LimitUsageWidget;

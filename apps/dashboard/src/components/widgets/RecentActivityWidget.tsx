import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import { StateCard } from "../ui/state-card.js";
import { StatusChip } from "../StatusChip.js";
import { agentLabel, vendorLabel } from "../../lib/identity.js";
import {
  formatMoney,
  formatRelative,
  formatTimestamp,
  outcomeChip,
  verificationChip,
  explainDecision,
} from "../../lib/format.js";
import { recentDecisions, lastUpdatedLabel } from "../../lib/activity.js";
import type { DecisionView } from "../../lib/types.js";

export function RecentActivityWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const [resolvedAt] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  const rows = recentDecisions(decisions, 5);

  return (
    <Card className="col-span-full lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>The five most recent decisions from the ledger</CardDescription>
        </div>
        <span className="text-[11.5px] text-ink-faint">{lastUpdatedLabel(resolvedAt, now)}</span>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <StateCard icon="activity" title="No decisions yet">
            Trigger a payment through the MCP <code>pay_vendor</code> tool and it appears here.
          </StateCard>
        ) : (
          <ul className="flex flex-col">
            {rows.map((v, i) => (
              <li key={v.decisionId} className={i > 0 ? "border-t border-line" : undefined}>
                <Link to={`/app/activity/${encodeURIComponent(v.decisionId)}`} className="block py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex flex-wrap items-baseline gap-1.5 text-[13.5px]">
                      <span className="font-medium text-ink">{agentLabel(v.agentId)}</span>
                      <span className="text-ink-faint" aria-hidden="true">→</span>
                      <span className="text-ink-muted">{vendorLabel(v.vendorId)}</span>
                      <span className="tabular font-semibold text-ink">
                        {formatMoney(v.amount, v.request?.currency ?? "USD")}
                      </span>
                    </div>
                    <span className="text-[11.5px] text-ink-faint" title={formatTimestamp(v.ts)}>
                      {formatRelative(v.ts, now)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <StatusChip chip={outcomeChip(v)} />
                    <StatusChip chip={verificationChip(v.proofVerification.reason)} />
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug text-ink-faint">{explainDecision(v)}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default RecentActivityWidget;

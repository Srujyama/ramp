import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ShieldCheck, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import { StateCard } from "../ui/state-card.js";
import { summarizeVendors } from "../../lib/rollups.js";
import { formatMoney } from "../../lib/format.js";
import type { DecisionView } from "../../lib/types.js";

export function VendorBreakdownWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const vendors = summarizeVendors(decisions).slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Top vendors</CardTitle>
          <CardDescription>By settled spend, in window</CardDescription>
        </div>
        <Link to="/app/vendors" className="flex items-center gap-1 text-[12.5px] font-medium text-lime-ink hover:underline">
          All <ArrowRight className="size-3.5" />
        </Link>
      </CardHeader>
      <CardContent>
        {vendors.length === 0 ? (
          <StateCard icon="building" title="No vendor spend yet" />
        ) : (
          <ul className="flex flex-col gap-3">
            {vendors.map((v) => (
              <li key={v.vendorId} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {v.verified === true ? (
                    <ShieldCheck className="size-4 shrink-0 text-lime" />
                  ) : v.verified === false ? (
                    <ShieldAlert className="size-4 shrink-0 text-chart-deny" />
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <span className="truncate text-[13.5px] text-ink">{v.label}</span>
                </div>
                <span className="tabular shrink-0 text-[13.5px] font-semibold text-ink">
                  {formatMoney(v.settledSpend, "USD")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default VendorBreakdownWidget;

import type { JSX } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import { StateCard } from "../ui/state-card.js";
import { Donut } from "../charts/Donut.js";
import { summarizeCategories } from "../../lib/rollups.js";
import type { DecisionView } from "../../lib/types.js";

export function CategoryBreakdownWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const categories = summarizeCategories(decisions).filter((c) => c.settledSpend > 0);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Spend by category</CardTitle>
          <CardDescription>Settled spend, ranked</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <StateCard icon="inbox" title="No settled spend yet" />
        ) : (
          <Donut slices={categories.map((c) => ({ key: c.category, label: c.category.replace(/_/g, " "), value: c.settledSpend }))} />
        )}
      </CardContent>
    </Card>
  );
}

export default CategoryBreakdownWidget;

import type { JSX } from "react";
import { PlugZap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";

/**
 * A widget for a metric that genuinely doesn't exist in the ledger yet
 * (cost-per-query, LLM provider spend — see lib/agents.ts's header comment).
 * Rendered as an honest invitation, never mock numbers: this is the
 * "real-derived only" line the design brief drew.
 */
export function PlaceholderWidget({ title, description }: { title: string; description: string }): JSX.Element {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <div>
          <CardTitle className="text-ink-muted">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <PlugZap className="size-5 text-ink-faint" strokeWidth={1.5} />
          <p className="max-w-xs text-[12.5px] text-ink-faint">
            Not tracked by the ledger yet. This widget is a placeholder, not illustrative data. Remove it
            from Add widget until a real source exists.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default PlaceholderWidget;

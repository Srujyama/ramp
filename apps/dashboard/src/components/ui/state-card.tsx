import type { JSX, ReactNode } from "react";
import { CreditCard, Activity, Inbox, ShieldQuestion, Building2, WifiOff, TriangleAlert, SearchX } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { BridgeError } from "../../lib/bridge.js";
import { Button } from "./button.js";

const ICONS = {
  card: CreditCard,
  activity: Activity,
  inbox: Inbox,
  shield: ShieldQuestion,
  building: Building2,
  offline: WifiOff,
  warn: TriangleAlert,
  notfound: SearchX,
} as const;

export type StateIcon = keyof typeof ICONS;

/** Honest empty/offline/not-found state — never a blank div, never fake data. */
export function StateCard({
  icon = "inbox",
  title,
  children,
  action,
  tone = "neutral",
  onRetry,
  className,
}: {
  icon?: StateIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  onRetry?: () => void;
  className?: string;
}): JSX.Element {
  const Icon = ICONS[icon];
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center",
        tone === "error" ? "border-flag/30 bg-flag-soft/40" : "border-line-strong bg-surface-sunken/50",
        className,
      )}
    >
      <Icon className={cn("size-6", tone === "error" ? "text-flag" : "text-ink-faint")} strokeWidth={1.5} />
      <h4 className="text-[14px] font-semibold text-ink">{title}</h4>
      {children ? <p className="max-w-sm text-[13px] text-ink-muted">{children}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-1">
          Retry
        </Button>
      ) : null}
      {action}
    </div>
  );
}

/** Render a fetch failure as the right honest state, keyed on BridgeError.kind. */
export function BridgeErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }): JSX.Element {
  if (error instanceof BridgeError && error.kind === "unavailable") {
    return (
      <StateCard icon="offline" title="Ledger bridge unavailable" tone="error" onRetry={onRetry}>
        The dashboard couldn't reach the read-only audit bridge. Start it with{" "}
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">
          pnpm --filter @ramp/ledger bridge
        </code>{" "}
        and confirm the URL.
      </StateCard>
    );
  }
  if (error instanceof BridgeError && error.kind === "malformed") {
    return (
      <StateCard icon="warn" title="Unexpected response" tone="error" onRetry={onRetry}>
        The bridge answered, but the response wasn't the shape the dashboard expects. It may be a version
        mismatch.
      </StateCard>
    );
  }
  if (error instanceof BridgeError && error.kind === "not_found") {
    return (
      <StateCard icon="notfound" title="Decision not found" onRetry={onRetry}>
        No decision with that id is in the audit trail.
      </StateCard>
    );
  }
  return (
    <StateCard icon="warn" title="Something went wrong" tone="error" onRetry={onRetry}>
      {error instanceof Error ? error.message : "Unknown error reading the ledger."}
    </StateCard>
  );
}

export default StateCard;

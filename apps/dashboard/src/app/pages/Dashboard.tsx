import { useEffect } from "react";
import type { JSX } from "react";
import { Plus, Check } from "lucide-react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { useWidgetPrefs, WIDGETS } from "../../lib/useWidgetPrefs.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Button } from "../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import SpendOverviewWidget from "../../components/widgets/SpendOverviewWidget.js";
import AgentFleetWidget from "../../components/widgets/AgentFleetWidget.js";
import TrustSummaryWidget from "../../components/widgets/TrustSummaryWidget.js";
import RecentActivityWidget from "../../components/widgets/RecentActivityWidget.js";
import CategoryBreakdownWidget from "../../components/widgets/CategoryBreakdownWidget.js";
import VendorBreakdownWidget from "../../components/widgets/VendorBreakdownWidget.js";
import LimitUsageWidget from "../../components/widgets/LimitUsageWidget.js";
import PlaceholderWidget from "../../components/widgets/PlaceholderWidget.js";

function AddWidgetMenu({
  enabled,
  toggle,
}: {
  enabled: Record<string, boolean>;
  toggle: (key: string) => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          <Plus className="size-4" /> Add widget
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Widgets</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {WIDGETS.map((w) => (
          <DropdownMenuItem
            key={w.key}
            onSelect={(e) => {
              e.preventDefault();
              toggle(w.key);
            }}
            className="flex-col items-start gap-0"
          >
            <span className="flex w-full items-center gap-2">
              <span className="flex size-4 items-center justify-center">
                {enabled[w.key] ? <Check className="size-3.5 text-lime" /> : null}
              </span>
              <span className="font-medium text-ink">{w.title}</span>
              {w.placeholder ? <span className="ml-auto text-[10px] text-ink-faint">no data yet</span> : null}
            </span>
            <span className="pl-6 text-[11.5px] text-ink-faint">{w.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DashboardSkeleton(): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Skeleton className="col-span-full h-16" />
      <Skeleton className="col-span-full h-[360px] lg:col-span-2" />
      <Skeleton className="h-[360px]" />
      <Skeleton className="h-[360px]" />
    </div>
  );
}

export function Dashboard(): JSX.Element {
  const win = useDecisionsWindow();
  const { enabled, toggle } = useWidgetPrefs();

  useEffect(() => {
    document.title = "Dashboard · Provable Agent Spend";
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Dashboard</h1>
          <p className="text-[13.5px] text-ink-muted">Agent spend, at a glance — every figure below is real.</p>
        </div>
        <AddWidgetMenu enabled={enabled} toggle={toggle} />
      </div>

      {win.status === "loading" ? (
        <DashboardSkeleton />
      ) : win.status === "error" ? (
        <BridgeErrorState error={win.error} onRetry={win.reload} />
      ) : win.data.decisions.length === 0 ? (
        <StateCard icon="activity" title="No decisions yet">
          Trigger a payment through the MCP <code>pay_vendor</code> tool and your agent fleet appears here.
        </StateCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {enabled.agentFleet ? <AgentFleetWidget decisions={win.data.decisions} /> : null}
          {enabled.spendOverview ? <SpendOverviewWidget decisions={win.data.decisions} /> : null}
          {enabled.trustSummary ? <TrustSummaryWidget decisions={win.data.decisions} /> : null}
          {enabled.recentActivity ? <RecentActivityWidget decisions={win.data.decisions} /> : null}
          {enabled.categoryBreakdown ? <CategoryBreakdownWidget decisions={win.data.decisions} /> : null}
          {enabled.vendorBreakdown ? <VendorBreakdownWidget decisions={win.data.decisions} /> : null}
          {enabled.limitUsage ? <LimitUsageWidget decisions={win.data.decisions} /> : null}
          {enabled.costPerQuery ? (
            <PlaceholderWidget title="Cost per query" description="Per-call model cost" />
          ) : null}
          {enabled.providerBreakdown ? (
            <PlaceholderWidget title="LLM provider breakdown" description="Spend by model provider" />
          ) : null}
        </div>
      )}
    </div>
  );
}

export default Dashboard;

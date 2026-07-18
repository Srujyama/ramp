import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import { Plus } from "lucide-react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { summarizeAgents } from "../../lib/agents.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { AgentCard } from "../../components/AgentCard.js";
import { CreateAgentModal } from "../../components/CreateAgentModal.js";
import HeroStatsWidget from "../../components/widgets/HeroStatsWidget.js";
import SpendOverviewWidget from "../../components/widgets/SpendOverviewWidget.js";
import TrustSummaryWidget from "../../components/widgets/TrustSummaryWidget.js";
import RecentActivityWidget from "../../components/widgets/RecentActivityWidget.js";
import CategoryBreakdownWidget from "../../components/widgets/CategoryBreakdownWidget.js";
import VendorBreakdownWidget from "../../components/widgets/VendorBreakdownWidget.js";
import ModelPricingWidget from "../../components/widgets/ModelPricingWidget.js";
import type { DecisionView } from "../../lib/types.js";

function DashboardSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[300px] w-full" />
      <div className="flex gap-4">
        <Skeleton className="h-[230px] w-[300px] shrink-0" />
        <Skeleton className="h-[230px] w-[300px] shrink-0" />
        <Skeleton className="h-[230px] w-[300px] shrink-0" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="col-span-full h-[280px] lg:col-span-2" />
        <Skeleton className="h-[280px]" />
      </div>
    </div>
  );
}

/**
 * The fleet, as a row of physical-card objects, plus the one place a new agent
 * gets registered. No `onCreated` reload here: the fleet is derived only from
 * decisions (there's no agent-registry endpoint — see lib/agents.ts), so a
 * freshly registered agent with zero spend has nothing to show until it
 * actually transacts. Reloading the whole decisions window on success would
 * only flip this section to its loading skeleton mid-dialog, for no payoff.
 */
function AgentFleet({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const agents = useMemo(() => summarizeAgents(decisions), [decisions]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[15px] font-semibold text-ink">Agent fleet</h2>
        <CreateAgentModal
          trigger={
            <Button variant="secondary" size="sm">
              <Plus className="size-4" /> Create agent
            </Button>
          }
        />
      </div>
      {agents.length === 0 ? (
        <StateCard icon="card" title="No agents active yet">
          Trigger a payment through the MCP <code>pay_vendor</code> tool, or register one above.
        </StateCard>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-1">
          {agents.map((a) => (
            <AgentCard key={a.agentId} agent={a} className="w-[300px] shrink-0" />
          ))}
        </div>
      )}
    </div>
  );
}

export function Dashboard(): JSX.Element {
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = "Dashboard · Warrant";
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Dashboard</h1>
        <p className="text-[13.5px] text-ink-muted">Agentic spend, at a glance.</p>
      </div>

      {win.status === "loading" ? (
        <DashboardSkeleton />
      ) : win.status === "error" ? (
        <BridgeErrorState error={win.error} onRetry={win.reload} />
      ) : (
        <>
          <HeroStatsWidget decisions={win.data.decisions} />
          <SpendOverviewWidget decisions={win.data.decisions} />
          <AgentFleet decisions={win.data.decisions} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <RecentActivityWidget decisions={win.data.decisions} />
            <TrustSummaryWidget decisions={win.data.decisions} />
            <CategoryBreakdownWidget decisions={win.data.decisions} />
            <VendorBreakdownWidget decisions={win.data.decisions} />
            <ModelPricingWidget />
          </div>
        </>
      )}
    </div>
  );
}

export default Dashboard;

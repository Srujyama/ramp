import { useEffect } from "react";
import type { JSX } from "react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import { summarizeAgents } from "../../lib/agents.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { AgentCard } from "../../components/AgentCard.js";
import { TruncationNotice } from "../../components/TruncationNotice.js";

export function Agents(): JSX.Element {
  const win = useDecisionsWindow();

  useEffect(() => {
    document.title = "Agent cards · Provable Agent Spend";
  }, []);

  const agents = win.status === "success" ? summarizeAgents(win.data.decisions) : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Agent cards</h1>
        <p className="text-[13.5px] text-ink-muted">
          Every AI agent that has requested spend. Clearances, limits, and trust, per card.
        </p>
      </div>

      {win.status === "loading" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[280px]" />
          ))}
        </div>
      ) : win.status === "error" ? (
        <BridgeErrorState error={win.error} onRetry={win.reload} />
      ) : agents.length === 0 ? (
        <StateCard icon="card" title="No agent activity yet">
          Trigger a payment through the MCP <code>pay_vendor</code> tool and its agent card appears here.
        </StateCard>
      ) : (
        <>
          <TruncationNotice truncated={win.data.truncated} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((a) => (
              <AgentCard key={a.agentId} agent={a} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default Agents;

import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { summarizeAgents } from "../../lib/agents.js";
import type { DecisionView } from "../../lib/types.js";
import { AgentCard } from "../AgentCard.js";
import { StateCard } from "../ui/state-card.js";

export function AgentFleetWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const agents = summarizeAgents(decisions).slice(0, 4);

  return (
    <div className="col-span-full">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 className="font-display text-[17px] font-semibold text-ink">Agent cards</h2>
          <p className="text-[13px] text-ink-muted">Spend clearances, limits, and trust — per agent.</p>
        </div>
        <Link
          to="/app/agents"
          className="flex items-center gap-1 text-[13px] font-medium text-lime-ink hover:underline"
        >
          View all <ArrowRight className="size-3.5" />
        </Link>
      </div>
      {agents.length === 0 ? (
        <StateCard icon="card" title="No agent activity yet">
          Once an agent's spend requests are recorded, its card appears here.
        </StateCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {agents.map((a) => (
            <AgentCard key={a.agentId} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}

export default AgentFleetWidget;

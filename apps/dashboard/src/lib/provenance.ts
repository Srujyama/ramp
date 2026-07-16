/**
 * @ramp/dashboard — provenance → readable flow
 *
 * Collapses the (essentially linear) provenance DAG the ledger records into the
 * five-step story a human reads:
 *
 *   Agent request → Trusted facts loaded → Policy evaluated → Decision produced
 *   → Payment executed or blocked
 *
 * Enriches each step from the real provenance graph when present, and degrades
 * gracefully (deriving from the decision itself) when a row has no stored
 * provenance — without ever overstating what happened.
 */
import type { DecisionView, ProvenanceGraph } from "./types.js";
import { formatMoney, paymentChip, type Tone } from "./format.js";

export interface FlowStep {
  key: string;
  title: string;
  detail: string;
  tone: Tone;
  /** Fact-source labels, only on the "Trusted facts" step. */
  sources?: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  tool_args: "tool args",
  vendor_registry: "vendor registry",
  ledger_db: "ledger db",
  policy_config: "policy config",
  attestation: "attestation",
};

/** Distinct fact sources from the provenance graph's `facts_src:*` arg nodes. */
function factSources(graph: ProvenanceGraph | null): string[] {
  if (!graph) return [];
  return graph.nodes
    .filter((n) => n.kind === "arg" && n.id.startsWith("facts_src:"))
    .map((n) => n.id.slice("facts_src:".length))
    .map((s) => SOURCE_LABEL[s] ?? s)
    .sort();
}

export function decisionFlow(v: DecisionView): FlowStep[] {
  const sources = factSources(v.provenance);
  const factsDetail =
    sources.length > 0
      ? `${sources.length} authoritative source${sources.length === 1 ? "" : "s"}`
      : v.facts
        ? "authoritative facts assembled"
        : "facts unavailable for this row";

  const pay = paymentChip(v);
  const amountStr =
    v.request !== null ? formatMoney(v.amount, v.request.currency) : `${v.amount}`;

  return [
    {
      key: "request",
      title: "Agent request",
      detail: `${v.agentId} → ${v.vendorId} · ${amountStr}`,
      tone: "info",
    },
    {
      key: "facts",
      title: "Trusted facts loaded",
      detail: factsDetail,
      tone: "info",
      sources,
    },
    {
      key: "policy",
      title: "Policy evaluated",
      detail: v.kernelId ? `deterministic engine · ${v.kernelId}` : "deterministic policy engine",
      tone: "info",
    },
    {
      key: "decision",
      title: "Decision produced",
      detail:
        v.outcome === "allow"
          ? "allow: every condition held"
          : v.outcome === "deny"
            ? `deny: ${v.firedRules.length} rule${v.firedRules.length === 1 ? "" : "s"} fired`
            : v.outcome === "escalate"
              ? `escalate: held for a human, ${v.firedRules.length} rule${v.firedRules.length === 1 ? "" : "s"} fired`
              : "no policy decision (error row)",
      tone: v.outcome === "allow" ? "accent" : v.outcome === "deny" ? "deny" : v.outcome === "escalate" ? "warn" : "warn",
    },
    {
      key: "payment",
      title: v.outcome === "deny" ? "Payment blocked" : v.outcome === "escalate" ? "Payment held" : "Payment executed",
      detail: pay.title,
      tone: pay.tone,
    },
  ];
}

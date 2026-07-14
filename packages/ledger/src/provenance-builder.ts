/**
 * @ramp/ledger — provenance-builder.ts
 *
 * A DETERMINISTIC provenance-graph builder. It DERIVES an independent provenance
 * DAG from TRUSTED execution context only (the spend request, the authoritative
 * facts the kernel evaluated, the decision, and — when they genuinely exist —
 * upstream task-chain / tool-call ids). It then feeds the graph to `buildProof`,
 * which validates it via `validateProvenance` and folds it into the proof hash.
 *
 * SECURITY POSTURE: there is NO "provenance" channel in the input. An agent can
 * never hand us a graph to embed; the builder RECONSTRUCTS the real chain of
 * events from trusted inputs. Optional task/tool nodes appear ONLY when their
 * value is genuinely supplied — never fabricated.
 *
 * DETERMINISM: no Date.now(), no Math.random(), no key-insertion nondeterminism.
 * Identical input yields byte-identical `nodes` and `edges` arrays: core nodes in
 * a fixed sequence, per-source arg nodes sorted alphabetically, edges in a fixed
 * sequence. The result is structurally valid (acyclic, endpoints exist, within
 * PROVENANCE_LIMITS) — but we do NOT call validateProvenance here; buildProof does.
 */
import type { SpendRequest, Facts, Decision, FactSource } from "@ramp/shared";
import { FACT_SOURCES } from "@ramp/shared";
import { type ProvenanceGraph, type ProvNode, type ProvEdge } from "./provenance.js";

/** Trusted inputs from which a provenance DAG is DERIVED (never agent-supplied). */
export interface DecisionProvenanceInput {
  readonly request: SpendRequest;
  readonly decision: Decision;
  /** Authoritative facts the kernel evaluated. Omit only for pre-facts errors. */
  readonly facts?: Facts;
  /** Which kernel produced the decision (e.g. getKernel().kind). */
  readonly kernelId?: string;
  /**
   * OPTIONAL genuine tool-call metadata from trusted execution context. Include a
   * tool_call node ONLY when this is supplied. Never fabricate it.
   */
  readonly toolCall?: { readonly id: string; readonly name?: string };
  /**
   * OPTIONAL genuine upstream task-chain id from trusted execution context. Adds a
   * task-chain node ONLY when supplied. Never fabricate.
   */
  readonly taskChainId?: string;
}

/** Stable ids for the fixed core nodes. Deterministic and opaque. */
const ID = {
  REQUEST_RECEIVED: "request_received",
  FACTS_LOADED: "facts_loaded",
  POLICY_EVALUATED: "policy_evaluated",
  DECISION_PRODUCED: "decision_produced",
  ACTION_ALLOWED: "action_allowed",
  ACTION_DENIED: "action_denied",
} as const;

/** Build a small scalar metadata bag, dropping undefined values (stable key order). */
function meta(
  entries: readonly (readonly [string, string | number | boolean | undefined])[],
): { readonly [k: string]: string | number | boolean } | undefined {
  const out: { [k: string]: string | number | boolean } = {};
  let any = false;
  for (const [k, v] of entries) {
    if (v !== undefined) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * The DISTINCT trusted fact-sources that actually contributed a fact, in a
 * deterministic (alphabetical) order. Derived from FACT_SOURCES over the keys
 * genuinely present in `facts`.
 */
function contributingSources(facts: Facts): FactSource[] {
  const seen = new Set<FactSource>();
  // Iterate FACT_SOURCES' fixed key set; include a source only when its fact is
  // actually present on the facts object (defensive against partial facts).
  for (const key of Object.keys(FACT_SOURCES) as (keyof Facts)[]) {
    if (facts[key] !== undefined) {
      seen.add(FACT_SOURCES[key]);
    }
  }
  return [...seen].sort();
}

/**
 * Derive a deterministic provenance DAG for one policy decision from trusted
 * execution context. See file header for the security & determinism contract.
 */
export function buildDecisionProvenance(input: DecisionProvenanceInput): ProvenanceGraph {
  const { request, decision, facts, kernelId, toolCall, taskChainId } = input;

  const nodes: ProvNode[] = [];
  const edges: ProvEdge[] = [];

  const hasFacts = facts !== undefined;
  const actionId = decision.decision === "allow" ? ID.ACTION_ALLOWED : ID.ACTION_DENIED;
  const actionLabel = decision.decision === "allow" ? "action allowed" : "action denied";

  // --- 1. request_received (always) ---
  // request_id / agent come from AUTHORITATIVE facts when present; request fields
  // are used only as fallback KEYS (their values are never trusted as facts).
  const requestId = facts?.request_id ?? request.invoiceRef;
  const agent = facts?.requesting_agent ?? request.requestingAgent;
  nodes.push({
    id: ID.REQUEST_RECEIVED,
    kind: "task",
    label: "spend request received",
    ...withMeta(meta([
      ["request_id", requestId],
      ["agent", agent],
    ])),
  });

  // --- 2. one arg node per DISTINCT contributing fact-source (sorted) ---
  const sources = hasFacts ? contributingSources(facts) : [];
  for (const source of sources) {
    nodes.push({
      id: `facts_src:${source}`,
      kind: "arg",
      label: `trusted facts from ${source}`,
      metadata: { source },
    });
  }

  // --- 3. facts_loaded (only when facts present) ---
  if (hasFacts) {
    nodes.push({
      id: ID.FACTS_LOADED,
      kind: "derived",
      label: "authoritative facts assembled",
    });
  }

  // --- 4. policy_evaluated (always) ---
  nodes.push({
    id: ID.POLICY_EVALUATED,
    kind: "derived",
    label: "policy evaluated",
    ...withMeta(meta([["kernelId", kernelId]])),
  });

  // --- 5. decision_produced (always) ---
  nodes.push({
    id: ID.DECISION_PRODUCED,
    kind: "derived",
    label: "decision produced",
    metadata: { outcome: decision.decision, firedRules: decision.firedRules.length },
  });

  // --- 6. action_allowed | action_denied (always) ---
  nodes.push({ id: actionId, kind: "derived", label: actionLabel });

  // --- 7. task-chain node (only when genuinely supplied) ---
  if (taskChainId !== undefined) {
    nodes.push({
      id: `task_chain:${taskChainId}`,
      kind: "task",
      label: "upstream task chain",
    });
  }

  // --- 8. tool-call node (only when genuinely supplied) ---
  if (toolCall !== undefined) {
    nodes.push({
      id: `tool_call:${toolCall.id}`,
      kind: "tool_call",
      label: "tool call",
      ...withMeta(meta([["name", toolCall.name]])),
    });
  }

  // ===== edges — fixed deterministic sequence =====

  if (hasFacts) {
    // request_received → facts_loaded, then each sorted source → facts_loaded
    edges.push({ parent: ID.REQUEST_RECEIVED, child: ID.FACTS_LOADED });
    for (const source of sources) {
      edges.push({ parent: `facts_src:${source}`, child: ID.FACTS_LOADED });
    }
    edges.push({ parent: ID.FACTS_LOADED, child: ID.POLICY_EVALUATED });
  } else {
    edges.push({ parent: ID.REQUEST_RECEIVED, child: ID.POLICY_EVALUATED });
  }

  edges.push({ parent: ID.POLICY_EVALUATED, child: ID.DECISION_PRODUCED });
  edges.push({ parent: ID.DECISION_PRODUCED, child: actionId });

  // optional upstream edges last (mirrors optional-nodes-last ordering)
  if (taskChainId !== undefined) {
    edges.push({ parent: `task_chain:${taskChainId}`, child: ID.REQUEST_RECEIVED });
  }
  if (toolCall !== undefined) {
    edges.push({ parent: `tool_call:${toolCall.id}`, child: ID.REQUEST_RECEIVED });
  }

  return { nodes, edges };
}

/** Spread-helper: attach a `metadata` key only when the bag is defined. */
function withMeta(
  m: { readonly [k: string]: string | number | boolean } | undefined,
): { metadata?: { readonly [k: string]: string | number | boolean } } {
  return m === undefined ? {} : { metadata: m };
}

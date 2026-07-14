/**
 * @ramp/ledger — provenance-builder.test.ts
 *
 * Determinism (deep + byte-identical), stable node/edge ordering, allow vs deny
 * paths, absent optional metadata, the ABSENCE of any untrusted-provenance channel,
 * structural validity via validateProvenance, and proof-hash sensitivity through
 * buildProof. Run with `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import { buildDecisionProvenance, type DecisionProvenanceInput } from "./provenance-builder.js";
import { validateProvenance } from "./provenance.js";
import { buildProof } from "./proof.js";

const req: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

const facts: Facts = {
  request_id: "inv_2026_07_0043",
  requesting_agent: "agent_47",
  amount: 340,
  vendor: "acme_corp",
  category: "office_supplies",
  vendor_verified: true,
  daily_total_so_far: 1140,
  per_txn_cap: 500,
  daily_limit: 1500,
  approved_categories: ["office_supplies", "software", "travel"],
  agent_cleared_categories: ["office_supplies", "software"],
  attestation_present: false,
};

const allow: Decision = {
  decision: "allow",
  reasons: ["allow: every policy condition held"],
  firedRules: ["allow/all_conditions_met"],
};

const deny: Decision = {
  decision: "deny",
  reasons: ["deny: over per-txn cap"],
  firedRules: ["deny/over_per_txn_cap"],
};

function ids(g: { nodes: readonly { id: string }[] }): string[] {
  return g.nodes.map((n) => n.id);
}
function edgePairs(g: { edges: readonly { parent: string; child: string }[] }): string[] {
  return g.edges.map((e) => `${e.parent}->${e.child}`);
}

const full: DecisionProvenanceInput = {
  request: req,
  decision: allow,
  facts,
  kernelId: "ts-reference",
  toolCall: { id: "call_1", name: "pay_vendor" },
  taskChainId: "chain_9",
};

test("deterministic: same input builds deep-equal AND byte-identical graphs", () => {
  const a = buildDecisionProvenance(full);
  const b = buildDecisionProvenance(full);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("stable NODE ordering (exact id sequence, full input)", () => {
  const g = buildDecisionProvenance(full);
  assert.deepEqual(ids(g), [
    "request_received",
    "facts_src:attestation",
    "facts_src:ledger_db",
    "facts_src:policy_config",
    "facts_src:tool_args",
    "facts_src:vendor_registry",
    "facts_loaded",
    "policy_evaluated",
    "decision_produced",
    "action_allowed",
    "task_chain:chain_9",
    "tool_call:call_1",
  ]);
});

test("stable EDGE ordering (exact sequence, full input)", () => {
  const g = buildDecisionProvenance(full);
  assert.deepEqual(edgePairs(g), [
    "request_received->facts_loaded",
    "facts_src:attestation->facts_loaded",
    "facts_src:ledger_db->facts_loaded",
    "facts_src:policy_config->facts_loaded",
    "facts_src:tool_args->facts_loaded",
    "facts_src:vendor_registry->facts_loaded",
    "facts_loaded->policy_evaluated",
    "policy_evaluated->decision_produced",
    "decision_produced->action_allowed",
    "task_chain:chain_9->request_received",
    "tool_call:call_1->request_received",
  ]);
});

test("allow path: action_allowed present, action_denied absent", () => {
  const g = buildDecisionProvenance({ request: req, decision: allow, facts });
  const idset = new Set(ids(g));
  assert.ok(idset.has("action_allowed"));
  assert.ok(!idset.has("action_denied"));
});

test("deny path: action_denied present, action_allowed absent", () => {
  const g = buildDecisionProvenance({ request: req, decision: deny, facts });
  const idset = new Set(ids(g));
  assert.ok(idset.has("action_denied"));
  assert.ok(!idset.has("action_allowed"));
  assert.equal(edgePairs(g).at(-1), "decision_produced->action_denied");
});

test("unavailable optional metadata: no toolCall/taskChainId → no tool_call/task-chain nodes", () => {
  const g = buildDecisionProvenance({ request: req, decision: allow, facts });
  for (const id of ids(g)) {
    assert.ok(!id.startsWith("tool_call:"));
    assert.ok(!id.startsWith("task_chain:"));
  }
});

test("facts absent: no facts_loaded / arg nodes, chain still valid", () => {
  const g = buildDecisionProvenance({ request: req, decision: allow });
  assert.deepEqual(ids(g), [
    "request_received",
    "policy_evaluated",
    "decision_produced",
    "action_allowed",
  ]);
  assert.deepEqual(edgePairs(g), [
    "request_received->policy_evaluated",
    "policy_evaluated->decision_produced",
    "decision_produced->action_allowed",
  ]);
  assert.doesNotThrow(() => validateProvenance(g));
});

test("no untrusted-provenance channel: only trusted fields influence output", () => {
  // The input type has NO `provenance` field. Attaching arbitrary extra keys must
  // be ignored — output depends solely on request/decision/facts/kernelId/toolCall/
  // taskChainId. (Cast through unknown to smuggle a rogue key past the type.)
  const rogue = {
    request: req,
    decision: allow,
    facts,
    kernelId: "ts-reference",
    toolCall: { id: "call_1", name: "pay_vendor" },
    taskChainId: "chain_9",
    provenance: { nodes: [{ id: "EVIL", kind: "task" }], edges: [] },
    injectedNode: { id: "ALSO_EVIL" },
  } as unknown as DecisionProvenanceInput;

  const clean = buildDecisionProvenance(full);
  const smuggled = buildDecisionProvenance(rogue);
  assert.deepEqual(smuggled, clean);
  assert.ok(!ids(smuggled).includes("EVIL"));
  assert.ok(!ids(smuggled).includes("ALSO_EVIL"));
});

test("request metadata prefers AUTHORITATIVE facts over request keys", () => {
  // facts.request_id / requesting_agent win; request fields are fallback only.
  const otherFacts: Facts = { ...facts, request_id: "req_auth", requesting_agent: "agent_auth" };
  const g = buildDecisionProvenance({ request: req, decision: allow, facts: otherFacts });
  const rr = g.nodes.find((n) => n.id === "request_received");
  assert.equal(rr?.metadata?.request_id, "req_auth");
  assert.equal(rr?.metadata?.agent, "agent_auth");

  // facts absent → falls back to request fields as keys.
  const g2 = buildDecisionProvenance({ request: req, decision: allow });
  const rr2 = g2.nodes.find((n) => n.id === "request_received");
  assert.equal(rr2?.metadata?.request_id, "inv_2026_07_0043");
  assert.equal(rr2?.metadata?.agent, "agent_47");
});

test("decision_produced records outcome + fired-rule count", () => {
  const g = buildDecisionProvenance({ request: req, decision: deny, facts });
  const dp = g.nodes.find((n) => n.id === "decision_produced");
  assert.equal(dp?.metadata?.outcome, "deny");
  assert.equal(dp?.metadata?.firedRules, 1);
});

test("validateProvenance does NOT throw for allow / deny / facts-absent / optional-present", () => {
  const variants: DecisionProvenanceInput[] = [
    { request: req, decision: allow, facts },
    { request: req, decision: deny, facts },
    { request: req, decision: allow },
    { request: req, decision: allow, facts, toolCall: { id: "c1" }, taskChainId: "t1" },
    { request: req, decision: allow, taskChainId: "t1" }, // facts-absent + upstream
  ];
  for (const v of variants) {
    assert.doesNotThrow(() => validateProvenance(buildDecisionProvenance(v)));
  }
});

test("proof-hash sensitivity: attaching the derived provenance moves proofId", () => {
  const prov = buildDecisionProvenance(full);
  const baseInput = {
    decisionId: "dec_1",
    request: req,
    decision: allow,
    facts,
    producedAt: 1_700_000_000_000,
    latencyMs: 3,
  } as const;

  const without = buildProof({ ...baseInput });
  const withProv = buildProof({ ...baseInput, provenance: prov });
  assert.notEqual(without.proofId, withProv.proofId);
  // Graph is valid, so buildProof succeeds and embeds it verbatim.
  assert.deepEqual(withProv.provenance, prov);
});

test("proof-hash sensitivity: two DIFFERENT provenance graphs → different proofId", () => {
  const provAllow = buildDecisionProvenance({ request: req, decision: allow, facts });
  const provDeny = buildDecisionProvenance({ request: req, decision: deny, facts });
  const baseInput = {
    decisionId: "dec_1",
    request: req,
    decision: allow, // hold decision fixed so ONLY provenance differs in the hash
    facts,
    producedAt: 1_700_000_000_000,
  } as const;
  assert.notEqual(
    buildProof({ ...baseInput, provenance: provAllow }).proofId,
    buildProof({ ...baseInput, provenance: provDeny }).proofId,
  );
});

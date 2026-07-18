/**
 * @ramp/dashboard — provenance.test.ts
 *
 * The DAG → readable-flow collapse. Five ordered steps, an honest terminal step
 * (blocked vs executed vs failed), and fact-source extraction from the graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionFlow } from "./provenance.js";
import type { ProvenanceGraph } from "./types.js";
import { mkView } from "./testfixtures.js";

const graph: ProvenanceGraph = {
  nodes: [
    { id: "request_received", kind: "task" },
    { id: "facts_src:vendor_registry", kind: "arg" },
    { id: "facts_src:ledger_db", kind: "arg" },
    { id: "facts_loaded", kind: "derived" },
    { id: "policy_evaluated", kind: "derived" },
    { id: "decision_produced", kind: "derived" },
    { id: "action_allowed", kind: "derived" },
  ],
  edges: [],
};

test("decisionFlow yields the five canonical steps in order", () => {
  const steps = decisionFlow(mkView());
  assert.deepEqual(
    steps.map((s) => s.key),
    ["request", "facts", "policy", "decision", "payment"],
  );
});

test("fact sources are extracted and labeled from the graph", () => {
  const steps = decisionFlow(mkView({ provenance: graph }));
  const facts = steps.find((s) => s.key === "facts");
  assert.ok(facts?.sources);
  assert.deepEqual(facts.sources, ["ledger db", "vendor registry"]); // sorted, humanized
});

test("terminal step is honest: executed vs blocked vs failed", () => {
  const settled = decisionFlow(
    mkView({ execution: { settlementId: "r", executionId: "e", status: "settled", provider: "sandbox", executedAt: "2026-07-14 10:00:00" } }),
  ).at(-1);
  assert.equal(settled?.title, "Payment executed");
  assert.equal(settled?.tone, "accent");

  const denied = decisionFlow(mkView({ outcome: "deny", status: "denied" })).at(-1);
  assert.equal(denied?.title, "Payment blocked");

  const failed = decisionFlow(
    mkView({ execution: { settlementId: "r", executionId: "e", status: "failed", provider: "sandbox", executedAt: "2026-07-14 10:00:00" } }),
  ).at(-1);
  assert.equal(failed?.tone, "deny");
});

test("decision step reflects the outcome", () => {
  const allow = decisionFlow(mkView()).find((s) => s.key === "decision");
  assert.equal(allow?.tone, "accent");
  const deny = decisionFlow(mkView({ outcome: "deny", status: "denied", firedRules: ["deny/vendor_not_verified"] })).find(
    (s) => s.key === "decision",
  );
  assert.equal(deny?.tone, "deny");
  assert.match(deny?.detail ?? "", /1 rule/);
});

test("escalate never reads as 'no policy decision' — a verdict was reached, just held", () => {
  const steps = decisionFlow(
    mkView({ outcome: "escalate", status: "escalated", firedRules: ["escalate/over_escalation_threshold"], execution: null }),
  );
  const decision = steps.find((s) => s.key === "decision");
  assert.doesNotMatch(decision?.detail ?? "", /no policy decision/);
  assert.match(decision?.detail ?? "", /escalate/);

  const payment = steps.at(-1);
  assert.equal(payment?.title, "Payment held");
  assert.notEqual(payment?.title, "Payment executed");
});

/**
 * @ramp/ledger — provenance.test.ts
 *
 * Structural validation of provenance DAGs: valid chains + branching, and every
 * rejection kind (cycle, self-loop, missing node, duplicate id, oversized
 * count/depth/label/metadata, invalid id/kind). Run with `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateProvenance,
  ProvenanceError,
  PROVENANCE_LIMITS,
  type ProvNode,
  type ProvEdge,
  type ProvenanceGraph,
} from "./provenance.js";

function node(id: string, kind: ProvNode["kind"] = "tool_call"): ProvNode {
  return { id, kind };
}
function edge(parent: string, child: string): ProvEdge {
  return { parent, child };
}

/** Assert validateProvenance throws a ProvenanceError of the given kind. */
function expectKind(graph: ProvenanceGraph, kind: string): void {
  assert.throws(
    () => validateProvenance(graph),
    (e: unknown) => e instanceof ProvenanceError && e.kind === kind,
    `expected ProvenanceError kind=${kind}`,
  );
}

test("valid linear chain passes", () => {
  const g: ProvenanceGraph = {
    nodes: [node("t", "task"), node("a"), node("b")],
    edges: [edge("t", "a"), edge("a", "b")],
  };
  assert.doesNotThrow(() => validateProvenance(g));
});

test("valid branching / multi-parent DAG passes", () => {
  const g: ProvenanceGraph = {
    nodes: [node("t", "task"), node("a"), node("b"), node("c")],
    edges: [edge("t", "a"), edge("t", "b"), edge("a", "c"), edge("b", "c")],
  };
  assert.doesNotThrow(() => validateProvenance(g));
});

test("empty graph rejected", () => {
  expectKind({ nodes: [], edges: [] }, "empty");
});

test("cycle rejected", () => {
  const g: ProvenanceGraph = {
    nodes: [node("a"), node("b")],
    edges: [edge("a", "b"), edge("b", "a")],
  };
  expectKind(g, "cycle");
});

test("self-loop rejected (distinct from cycle)", () => {
  const g: ProvenanceGraph = {
    nodes: [node("a")],
    edges: [edge("a", "a")],
  };
  expectKind(g, "self_loop");
});

test("missing-node edge endpoint rejected", () => {
  const g: ProvenanceGraph = {
    nodes: [node("a")],
    edges: [edge("a", "ghost")],
  };
  expectKind(g, "missing_node");
});

test("duplicate node id rejected", () => {
  const g: ProvenanceGraph = {
    nodes: [node("a"), node("a")],
    edges: [],
  };
  expectKind(g, "duplicate_node_id");
});

test("excessive node count rejected", () => {
  const nodes = Array.from({ length: PROVENANCE_LIMITS.MAX_NODES + 1 }, (_, i) =>
    node(`n${i}`),
  );
  expectKind({ nodes, edges: [] }, "too_many_nodes");
});

test("excessive edge count rejected", () => {
  const nodes = [node("a"), node("b")];
  const edges = Array.from({ length: PROVENANCE_LIMITS.MAX_EDGES + 1 }, () =>
    edge("a", "b"),
  );
  expectKind({ nodes, edges }, "too_many_edges");
});

test("excessive depth rejected", () => {
  // A chain of MAX_DEPTH+2 nodes has depth MAX_DEPTH+1 > MAX_DEPTH.
  const len = PROVENANCE_LIMITS.MAX_DEPTH + 2;
  const nodes = Array.from({ length: len }, (_, i) => node(`n${i}`));
  const edges = Array.from({ length: len - 1 }, (_, i) =>
    edge(`n${i}`, `n${i + 1}`),
  );
  expectKind({ nodes, edges }, "depth_exceeded");
});

test("oversized label rejected", () => {
  const big = "x".repeat(PROVENANCE_LIMITS.MAX_LABEL_BYTES + 1);
  const g: ProvenanceGraph = {
    nodes: [{ id: "a", kind: "task", label: big }],
    edges: [],
  };
  expectKind(g, "oversized_label");
});

test("oversized metadata rejected", () => {
  const big = "x".repeat(PROVENANCE_LIMITS.MAX_METADATA_BYTES + 1);
  const g: ProvenanceGraph = {
    nodes: [{ id: "a", kind: "task", metadata: { blob: big } }],
    edges: [],
  };
  expectKind(g, "oversized_metadata");
});

test("invalid (empty) node id rejected", () => {
  expectKind({ nodes: [node("")], edges: [] }, "invalid_node_id");
});

test("invalid node kind rejected", () => {
  const g = {
    nodes: [{ id: "a", kind: "bogus" as ProvNode["kind"] }],
    edges: [],
  };
  expectKind(g, "invalid_node_kind");
});

test("a valid graph at exactly the limits still passes", () => {
  const nodes = Array.from({ length: PROVENANCE_LIMITS.MAX_NODES }, (_, i) =>
    node(`n${i}`, i === 0 ? "task" : "tool_call"),
  );
  assert.doesNotThrow(() => validateProvenance({ nodes, edges: [] }));
});

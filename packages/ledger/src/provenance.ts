/**
 * @ramp/ledger — provenance.ts
 *
 * Bounded, pure-TypeScript provenance-DAG validation. ZERO runtime dependencies,
 * linear-time O(V+E), NO recursion (iterative Kahn topological sort).
 *
 * The traversal core (Kahn's algorithm with longest-path relaxation for depth) is
 * adapted from the reference `validate-provenance-dag.ts`. The reference, however,
 * only bounded node count + depth and silently ignored duplicate ids, dangling
 * edges, and self-loops. This validator makes ALL of those EXPLICIT typed errors.
 *
 * STRUCTURAL, NOT AUTHENTIC (crux): a structurally valid graph is NOT proof that
 * the provenance is authentic. The caller supplies these nodes/edges and can lie.
 * A passing result means "well-formed DAG within bounds" — never "trustworthy".
 * Authenticity would require an attestation, which lives elsewhere.
 */

/** Kind of a provenance node. Descriptive metadata only. */
export type ProvNodeKind = "task" | "tool_call" | "arg" | "derived";

/** One node in a provenance graph. `id` is opaque but bounded (see limits). */
export interface ProvNode {
  readonly id: string;
  readonly kind: ProvNodeKind;
  /** Optional human label; byte-bounded. */
  readonly label?: string;
  /** Optional descriptive bag; JSON-byte-bounded. Values are scalars. */
  readonly metadata?: { readonly [k: string]: string | number | boolean };
}

/** A directed parent → child edge. */
export interface ProvEdge {
  readonly parent: string;
  readonly child: string;
}

/** A caller-supplied provenance graph awaiting structural validation. */
export interface ProvenanceGraph {
  readonly nodes: readonly ProvNode[];
  readonly edges: readonly ProvEdge[];
}

/**
 * Named structural limits. Every bound is explicit so an oversized or pathological
 * graph is rejected deterministically rather than blowing up downstream cost.
 */
export const PROVENANCE_LIMITS = {
  /** Max nodes in one graph. */
  MAX_NODES: 500,
  /** Max edges in one graph (the reference had NO edge bound — this adds one). */
  MAX_EDGES: 2000,
  /** Max longest-path depth in hops. */
  MAX_DEPTH: 200,
  /** Max bytes of a node id. */
  MAX_ID_BYTES: 256,
  /** Max UTF-8 bytes of a node label. */
  MAX_LABEL_BYTES: 1024,
  /** Max UTF-8 bytes of a node's JSON-serialized metadata. */
  MAX_METADATA_BYTES: 4096,
} as const;

/** The closed set of structural failures {@link validateProvenance} can raise. */
export type ProvenanceErrorKind =
  | "empty"
  | "too_many_nodes"
  | "too_many_edges"
  | "invalid_node_id"
  | "duplicate_node_id"
  | "invalid_node_kind"
  | "oversized_label"
  | "oversized_metadata"
  | "missing_node"
  | "self_loop"
  | "cycle"
  | "depth_exceeded";

/** A typed structural-validation failure. `kind` is stable and machine-checkable. */
export class ProvenanceError extends Error {
  readonly kind: ProvenanceErrorKind;
  constructor(kind: ProvenanceErrorKind, message: string) {
    super(message);
    this.name = "ProvenanceError";
    this.kind = kind;
  }
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "task",
  "tool_call",
  "arg",
  "derived",
]);

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Validate a provenance graph's STRUCTURE. Returns nothing on success; throws a
 * {@link ProvenanceError} (with a typed `kind`) on the first violation. Linear
 * time, iterative — safe on adversarial input up to the named limits.
 *
 * Checks, in order: non-empty · node/edge counts · per-node id/kind/label/metadata
 * · edge endpoints exist · no self-loops · acyclic · bounded depth.
 *
 * Passing means "well-formed DAG", NOT "authentic" — see file header.
 */
export function validateProvenance(graph: ProvenanceGraph): void {
  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    throw new ProvenanceError("empty", "provenance graph has no nodes");
  }
  if (nodes.length > PROVENANCE_LIMITS.MAX_NODES) {
    throw new ProvenanceError(
      "too_many_nodes",
      `provenance graph exceeds MAX_NODES (${PROVENANCE_LIMITS.MAX_NODES})`,
    );
  }
  if (edges.length > PROVENANCE_LIMITS.MAX_EDGES) {
    throw new ProvenanceError(
      "too_many_edges",
      `provenance graph exceeds MAX_EDGES (${PROVENANCE_LIMITS.MAX_EDGES})`,
    );
  }

  // --- per-node validation + id set (duplicate detection) ---
  const ids = new Set<string>();
  for (const n of nodes) {
    if (typeof n.id !== "string" || n.id.length === 0) {
      throw new ProvenanceError("invalid_node_id", "node id must be a non-empty string");
    }
    if (byteLen(n.id) > PROVENANCE_LIMITS.MAX_ID_BYTES) {
      throw new ProvenanceError(
        "invalid_node_id",
        `node id exceeds MAX_ID_BYTES (${PROVENANCE_LIMITS.MAX_ID_BYTES}): ${n.id.slice(0, 32)}…`,
      );
    }
    if (ids.has(n.id)) {
      throw new ProvenanceError("duplicate_node_id", `duplicate node id: ${n.id}`);
    }
    ids.add(n.id);

    if (!VALID_KINDS.has(n.kind)) {
      throw new ProvenanceError("invalid_node_kind", `invalid node kind: ${String(n.kind)}`);
    }
    if (n.label !== undefined && byteLen(n.label) > PROVENANCE_LIMITS.MAX_LABEL_BYTES) {
      throw new ProvenanceError(
        "oversized_label",
        `node ${n.id} label exceeds MAX_LABEL_BYTES (${PROVENANCE_LIMITS.MAX_LABEL_BYTES})`,
      );
    }
    if (
      n.metadata !== undefined &&
      byteLen(JSON.stringify(n.metadata)) > PROVENANCE_LIMITS.MAX_METADATA_BYTES
    ) {
      throw new ProvenanceError(
        "oversized_metadata",
        `node ${n.id} metadata exceeds MAX_METADATA_BYTES (${PROVENANCE_LIMITS.MAX_METADATA_BYTES})`,
      );
    }
  }

  // --- per-edge validation: endpoints exist, no self-loops; build adjacency ---
  const childrenOf = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);

  for (const e of edges) {
    if (!ids.has(e.parent)) {
      throw new ProvenanceError("missing_node", `edge references missing parent: ${e.parent}`);
    }
    if (!ids.has(e.child)) {
      throw new ProvenanceError("missing_node", `edge references missing child: ${e.child}`);
    }
    if (e.parent === e.child) {
      throw new ProvenanceError("self_loop", `self-loop on node: ${e.parent}`);
    }
    let kids = childrenOf.get(e.parent);
    if (kids === undefined) {
      kids = [];
      childrenOf.set(e.parent, kids);
    }
    kids.push(e.child);
    indeg.set(e.child, (indeg.get(e.child) ?? 0) + 1);
  }

  // --- Kahn's topological sort (iterative): detects cycles + longest-path depth ---
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);

  const dist = new Map<string, number>();
  for (const id of ids) dist.set(id, 0);

  let processed = 0;
  let maxDepth = 0;
  // `queue` grows as nodes reach indegree 0; index-advanced worklist, never shifted.
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]!; // i < queue.length ⇒ defined (noUncheckedIndexedAccess)
    processed++;
    const du = dist.get(u) ?? 0;
    for (const v of childrenOf.get(u) ?? []) {
      if (du + 1 > (dist.get(v) ?? 0)) {
        dist.set(v, du + 1);
        if (du + 1 > maxDepth) maxDepth = du + 1;
      }
      const nd = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, nd);
      if (nd === 0) queue.push(v);
    }
  }

  if (processed < ids.size) {
    throw new ProvenanceError("cycle", "provenance graph contains a cycle");
  }
  if (maxDepth > PROVENANCE_LIMITS.MAX_DEPTH) {
    throw new ProvenanceError(
      "depth_exceeded",
      `provenance depth exceeds MAX_DEPTH (${PROVENANCE_LIMITS.MAX_DEPTH})`,
    );
  }
}

/**
 * @ramp/dashboard — bridge wire types
 *
 * These mirror the JSON the read-only ledger HTTP bridge serves
 * (`@ramp/ledger` `DecisionView`). They are DELIBERATELY duplicated here rather
 * than imported: `@ramp/ledger` is a Node package (node:http, node:sqlite), and
 * a browser bundle must not pull it in. The frozen request/facts/decision shapes
 * DO come from `@ramp/shared` (a pure type package) so they can never drift.
 *
 * If the bridge contract changes, update this file to match.
 */
import type {
  SpendRequest,
  Facts,
  Decision,
  DecisionOutcome,
  RuleId,
} from "@ramp/shared";

export type { SpendRequest, Facts, Decision, DecisionOutcome, RuleId };

// --- provenance --------------------------------------------------------------

export type ProvNodeKind = "task" | "tool_call" | "arg" | "derived";

export interface ProvNode {
  id: string;
  kind: ProvNodeKind;
  label?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface ProvEdge {
  parent: string;
  child: string;
}

export interface ProvenanceGraph {
  nodes: ProvNode[];
  edges: ProvEdge[];
}

// --- proof -------------------------------------------------------------------

export type AttestationStatus =
  | "absent"
  | "present_unverified"
  | "verified"
  | "verification_failed";

export interface LedgerProof {
  schema: string;
  proofId: string;
  decisionId: string;
  decision: Decision;
  requestDigest: string;
  factsDigest: string | null;
  policyDigest: string | null;
  kernelId: string | null;
  kernelVersion: string | null;
  attestationStatus: AttestationStatus;
  attestationProvider: string | null;
  provenance: ProvenanceGraph | null;
  producedAt: number;
  latencyMs: number | null;
}

/** Four-valued independent proof-verification result. */
export type ProofVerificationReason = "ok" | "absent" | "corrupt" | "mismatch";

export interface DecisionProofVerification {
  proofPresent: boolean;
  proofVerified: boolean;
  expectedProofId: string | null;
  actualProofId: string | null;
  reason: ProofVerificationReason;
}

// --- execution ---------------------------------------------------------------

export type ExecutionStatus = "settled" | "failed";

export interface ExecutionRecord {
  settlementId: string;
  executionId: string;
  status: ExecutionStatus;
  provider: string;
  executedAt: string;
}

// --- decision ----------------------------------------------------------------

export type DecisionStatus = "allowed" | "denied" | "escalated" | "error";

/** One decision as served by `GET /decisions` and `GET /decisions/:id`. */
export interface DecisionView {
  decisionId: string;
  requestId: string;
  status: DecisionStatus;
  outcome: DecisionOutcome | null;
  agentId: string;
  vendorId: string;
  amount: number;
  category: string;
  attestationPresent: boolean | null;
  kernelId: string | null;
  request: SpendRequest | null;
  facts: Facts | null;
  decision: Decision | null;
  firedRules: RuleId[];
  proof: LedgerProof | null;
  execution: ExecutionRecord | null;
  ts: string;
  corrupt: boolean;
  provenance: ProvenanceGraph | null;
  proofVerified: boolean;
  proofVerification: DecisionProofVerification;
}

export interface DecisionListResponse {
  decisions: DecisionView[];
  nextCursor?: string;
}

// --- policy simulator --------------------------------------------------------
// Mirrors the `@ramp/ledger` `SimulationInput`/`SimulationResult` served by the
// read-only `GET /simulate` bridge route. Deliberately duplicated (not imported)
// for the same reason as the decision types above — the browser bundle must not
// pull in the Node ledger package. Keep in lockstep with `ledger/src/simulate.ts`.

export interface SimulationInput {
  agent: string;
  vendor: string;
  amount: number;
  category: string;
  currency?: string;
  /**
   * Whether to assume an attestation accompanied this hypothetical request.
   * Defaults to `true` server-side — a simulation has no real invoice to attest,
   * so without this every simulation would deny on `deny/attestation_invalid`.
   */
  attested?: boolean;
  /**
   * Whether to assume the hypothetical request was signed by the agent's
   * registered key. Defaults to `true` server-side for the same reason as
   * `attested` — a hypothetical carries no signature, and without the premise
   * every simulation would deny on `deny/unauthenticated_agent`.
   */
  identityVerified?: boolean;
}

/**
 * The result of a hypothetical evaluation. It is produced by the REAL policy
 * kernel over authoritative facts, but is completely side-effect free: no
 * decision, proof, or execution is ever persisted. `simulationOnly` is always
 * `true` — a wire-level marker that this row touched nothing.
 */
export interface SimulationResult {
  outcome: DecisionOutcome;
  firedRules: RuleId[];
  reasons: string[];
  facts: Facts;
  policyDigest: string;
  currency: string;
  /** The attestation premise this simulation assumed (see `SimulationInput.attested`). */
  assumedAttested: boolean;
  /** The identity premise this simulation assumed (see `SimulationInput.identityVerified`). */
  assumedIdentityVerified: boolean;
  simulationOnly: true;
}

/** Filters accepted by `GET /decisions`. */
export interface DecisionsQuery {
  agentId?: string;
  vendorId?: string;
  outcome?: DecisionOutcome;
  status?: DecisionStatus;
  firedRule?: RuleId;
  limit?: number;
  cursor?: string;
}

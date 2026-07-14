/**
 * @ramp/ledger — barrel
 *
 * The AUTHORITATIVE fact source for Provable Agent Spend. Everything the hook
 * needs to turn an untrusted `SpendRequest` into ground-truth facts is here:
 *   - `openLedger` / `closeLedger` — open the SQLite fact store (node:sqlite).
 *   - `LedgerFactSource` — the anti-injection DAL (`contextFor`, plus the
 *     granular authoritative reads).
 *
 * These are pure DB reads; they NEVER trust the model's narration.
 */
export {
  openLedger,
  closeLedger,
  isProvisioned,
  applySchema,
  applySeed,
  readSchemaSql,
  readSeedSql,
  DEFAULT_DB_PATH,
  IN_MEMORY_PATH,
  SCHEMA_SQL_PATH,
  SEED_SQL_PATH,
} from "./db.js";
export type { LedgerDb, OpenLedgerOptions } from "./db.js";

export { LedgerFactSource, makeFactSource } from "./dal.js";
export type { AuthoritativeContext, Limits } from "./dal.js";

// The audit trail: persist every gate decision and read it back (read-only API).
export {
  recordDecision,
  getDecision,
  listDecisions,
  isDecisionShape,
  DecisionConflictError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "./decision-log.js";
export type {
  DecisionStatus,
  RecordDecisionInput,
  RecordDecisionResult,
  DecisionRecord,
  ListDecisionsQuery,
  ListDecisionsResult,
} from "./decision-log.js";

// Tamper-evident proof: build, verify, and its ledger-local types (NOT in @ramp/shared).
export {
  buildProof,
  verifyProof,
  isLedgerProofShape,
  isAttestationStatus,
  PROOF_SCHEMA,
} from "./proof.js";
export type {
  LedgerProof,
  BuildProofInput,
  AttestationStatus,
  AttestationInput,
  ProofVerification,
  ProofSchema,
} from "./proof.js";

// Deterministic content hashing (node:crypto only) — canonical form + digests.
export {
  canonicalize,
  sha256OfJson,
  digestOf,
  hashStable,
} from "./canonical-hash.js";
export type { Json } from "./canonical-hash.js";

// Bounded, pure provenance-DAG validation (structural only — not authenticity).
export {
  validateProvenance,
  ProvenanceError,
  PROVENANCE_LIMITS,
} from "./provenance.js";
export type {
  ProvNode,
  ProvEdge,
  ProvenanceGraph,
  ProvNodeKind,
  ProvenanceErrorKind,
} from "./provenance.js";

// Deterministic, trust-derived provenance-DAG builder (feeds buildProof).
export { buildDecisionProvenance } from "./provenance-builder.js";
export type { DecisionProvenanceInput } from "./provenance-builder.js";

// First-class INDEPENDENT proof re-verification (recomputes; never trusts stored bytes).
export { verifyDecisionProof } from "./proof-verification.js";
export type {
  DecisionProofVerification,
  ProofVerificationReason,
} from "./proof-verification.js";

// Read-only ledger HTTP bridge (node:http only; no mutation routes).
export { createLedgerBridge, startLedgerBridge } from "./http-bridge.js";
export type { LedgerBridgeOptions, DecisionView } from "./http-bridge.js";

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
export { migrateDecisionsChecks } from "./migrate.js";

// The external witness. A receipt records (head, length); `verifyAgainstReceipt`
// asks whether the history you saw is still a PREFIX of the chain today — which
// is the question a growing chain can actually answer. Publish receipts somewhere
// the operator cannot rewrite; a receipt stored beside the ledger proves nothing.
export { publishHead, verifyAgainstReceipt } from "./head-receipt.js";
export type {
  HeadReceipt,
  HeadStatement,
  ConsistencyResult,
  ConsistencyFailure,
} from "./head-receipt.js";

// Human resolution of an escalation. NOTE: `resolveEscalation` is HUMAN-CHANNEL
// ONLY — no MCP tool may reach it, or the requesting agent approves itself and
// escalation becomes theatre. Agent-facing code gets the read-only helpers.
export {
  signApproval,
  checkApprover,
  approvalSigningBytes,
  demoApproverKeyring,
  demoApproverPrivateKey,
  DEMO_APPROVERS,
  APPROVAL_DOMAIN,
} from "./approver.js";
export type {
  Approver,
  ApprovalStatement,
  SignedApproval,
  ApproverCheck,
  ApproverFailure,
} from "./approver.js";
export {
  resolveEscalation,
  approvalFor,
  isApprovedForPayment,
  listPendingEscalations,
  ApprovalError,
} from "./approval.js";
export type {
  ApprovalRecord,
  ApprovalVerdict,
  ResolveEscalationInput,
} from "./approval.js";
export {
  openLedger,
  openLedgerStrict,
  closeLedger,
  isProvisioned,
  applySchema,
  applySeed,
  readSchemaSql,
  readSeedSql,
  resolveDbPath,
  LedgerNotProvisionedError,
  DEFAULT_DB_PATH,
  IN_MEMORY_PATH,
  SCHEMA_SQL_PATH,
  SEED_SQL_PATH,
} from "./db.js";
export type { LedgerDb, OpenLedgerOptions } from "./db.js";

// NOTE: `AuthoritativeContext` is no longer re-exported here. It moved to
// @ramp/shared when the fact-source port was unified — the port and this package
// had disagreed on `contextFor`'s signature with nothing to catch it. Import it
// from @ramp/shared. `UnknownAgentError` is the fail-closed guard: an unknown
// agent must throw, not read as an authoritative zero-spend.
export { LedgerFactSource, makeFactSource, UnknownAgentError } from "./dal.js";
export type { Limits } from "./dal.js";

// Policy identity: a stable sha256 digest of the org policy that judges a request.
export { policyDigest, policyDocumentOf } from "./policy-digest.js";
export type { PolicyDocument } from "./policy-digest.js";

// Read-only Policy Simulator: run a hypothetical request through the real kernel.
// Side-effect free — never persists a decision, proof, or execution.
export { simulate } from "./simulate.js";
export type { SimulationInput, SimulationResult } from "./simulate.js";

// The audit trail: persist every gate decision and read it back (read-only API).
export {
  recordDecision,
  recordExecution,
  getDecision,
  listDecisions,
  isDecisionShape,
  DecisionConflictError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "./decision-log.js";
export type {
  DecisionStatus,
  ExecutionStatus,
  ExecutionRecord,
  RecordDecisionInput,
  RecordDecisionResult,
  RecordExecutionInput,
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
// Hash chain: tamper-evidence ACROSS decisions (deletion/reordering), which
// per-proof integrity cannot see. Publish `chainHead` where you don't control it.
export {
  verifyChain,
  chainHead,
  nextLink,
  linkHash,
  GENESIS_CHAIN_HASH,
} from "./chain.js";
export type {
  ChainVerification,
  ChainDefect,
  ChainDefectKind,
  ChainLink,
} from "./chain.js";

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

// Shared purchase lifecycle: the ONE fail-closed path (policy → provenance → proof
// → persist → independent re-verify → execute). Reused by every MCP client tool.
export { requestPurchase } from "./purchase.js";
export type {
  PaymentExecutor,
  ExecutorRequest,
  ExecutorReceipt,
  FactSourcePort,
  PurchaseStatus,
  RequestPurchaseInput,
  RequestPurchaseResult,
} from "./purchase.js";

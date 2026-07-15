/**
 * @ramp/ledger — proof.ts
 *
 * A ledger-LOCAL attestation record bound to one policy decision. All types here
 * stay inside @ramp/ledger — the frozen @ramp/shared contract is NOT touched.
 *
 * A proof is a tamper-evident summary of "given THESE inputs, the kernel returned
 * THIS decision". Its {@link LedgerProof.proofId} is a SHA-256 over the stable
 * content (everything except the volatile timing fields), so any change to the
 * request, facts, decision, fired-rule order, policy digest, kernel identity,
 * attestation result, or provenance changes the id — while re-recording the same
 * decision at a different time does not.
 *
 * INTEGRITY, NOT TRUTH: verifying a proof confirms the RECORD was not altered. It
 * does NOT assert the facts are real, nor that any attestation actually passed —
 * that is what {@link AttestationStatus} distinguishes, honestly.
 *
 * Shape adapted from the reference `policy-proof.ts` + `canonical-hash.ts`. The
 * reference had NO attestation status/provider and NO embedded provenance; those
 * are designed here to the Ramp spec.
 */
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import { digestOf, hashStable, type Json } from "./canonical-hash.js";
import { validateProvenance, type ProvenanceGraph } from "./provenance.js";

/** Current proof schema tag. Bump on any breaking shape change. */
export const PROOF_SCHEMA = "ramp/ledger-proof-v1" as const;
export type ProofSchema = typeof PROOF_SCHEMA;

/**
 * Attestation state — deliberately four-valued so we NEVER overclaim.
 *   - `absent`               — no attestation accompanied the request.
 *   - `present_unverified`   — an attestation blob exists but was not checked.
 *   - `verified`             — an attestation was checked and PASSED (real result).
 *   - `verification_failed`  — an attestation was checked and FAILED.
 * Only set `verified` when an actual verification produced that result.
 */
export type AttestationStatus =
  | "absent"
  | "present_unverified"
  | "verified"
  | "verification_failed";

const ATTESTATION_STATUSES: ReadonlySet<string> = new Set([
  "absent",
  "present_unverified",
  "verified",
  "verification_failed",
]);

/** Runtime guard for {@link AttestationStatus} (persistence boundary). */
export function isAttestationStatus(v: unknown): v is AttestationStatus {
  return typeof v === "string" && ATTESTATION_STATUSES.has(v);
}

/** Caller-supplied attestation info. `status` defaults to `absent` when omitted. */
export interface AttestationInput {
  readonly status: AttestationStatus;
  /** Who produced/checked the attestation (e.g. "tlsnotary"). Optional. */
  readonly provider?: string;
}

/** The tamper-evident proof record persisted alongside a decision. */
export interface LedgerProof {
  readonly schema: ProofSchema;
  /** Stable SHA-256 identity, `proof_<hex>`. Excludes volatile timing fields. */
  readonly proofId: string;
  /** The decision this proof attests. */
  readonly decisionId: string;
  /** The exact `Decision` verbatim (outcome, reasons, firedRules in order). */
  readonly decision: Decision;
  /** `sha256:` digest of the canonical spend request. */
  readonly requestDigest: string;
  /** `sha256:` digest of the canonical facts, or `null` when facts are absent. */
  readonly factsDigest: string | null;
  /** Digest of the policy document, when the caller has it. */
  readonly policyDigest: string | null;
  /** Which kernel produced the decision, when known. */
  readonly kernelId: string | null;
  /** Kernel version, when known. */
  readonly kernelVersion: string | null;
  /** Honest attestation state (see {@link AttestationStatus}). */
  readonly attestationStatus: AttestationStatus;
  /** Attestation provider, when known. */
  readonly attestationProvider: string | null;
  /** Structurally-validated provenance graph, when supplied. */
  readonly provenance: ProvenanceGraph | null;
  /** Epoch-ms production time. VOLATILE — excluded from `proofId`. */
  readonly producedAt: number;
  /** Optional production latency in ms. VOLATILE — excluded from `proofId`. */
  readonly latencyMs: number | null;
}

/** Top-level fields excluded from the stable identity (see canonical-hash). */
const VOLATILE_PROOF_FIELDS = ["proofId", "producedAt", "latencyMs"] as const;

/** Inputs to {@link buildProof}. */
export interface BuildProofInput {
  readonly decisionId: string;
  readonly request: SpendRequest;
  readonly decision: Decision;
  readonly facts?: Facts;
  readonly policyDigest?: string;
  readonly kernelId?: string;
  readonly kernelVersion?: string;
  readonly attestation?: AttestationInput;
  readonly provenance?: ProvenanceGraph;
  /** Epoch-ms production time. Defaults to `Date.now()`; pass for deterministic tests. */
  readonly producedAt?: number;
  readonly latencyMs?: number;
}

/**
 * Compute the stable `proof_<hex>` id for the meaningful content of a proof-shaped
 * object (everything except the volatile timing fields and the id itself).
 */
function computeProofId(proofSansId: {
  readonly [k: string]: Json;
}): string {
  return "proof_" + hashStable(proofSansId, VOLATILE_PROOF_FIELDS);
}

/**
 * Build a {@link LedgerProof} from a decision and its evidence.
 *
 * Digests are computed here (request always; facts when present). If a provenance
 * graph is supplied it is STRUCTURALLY VALIDATED first — an invalid graph throws a
 * `ProvenanceError` and no proof is produced. Missing policy/kernel/attestation
 * data is recorded as `null`/`absent`; nothing is fabricated.
 *
 * @throws {ProvenanceError} if `provenance` is structurally invalid.
 * @throws if a numeric input is a non-integer (canonicalization is integer-only).
 */
export function buildProof(input: BuildProofInput): LedgerProof {
  if (input.provenance !== undefined) {
    validateProvenance(input.provenance);
  }

  const requestDigest = digestOf(input.request as unknown as Json);
  const factsDigest =
    input.facts === undefined ? null : digestOf(input.facts as unknown as Json);

  const base = {
    schema: PROOF_SCHEMA,
    decisionId: input.decisionId,
    decision: input.decision,
    requestDigest,
    factsDigest,
    policyDigest: input.policyDigest ?? null,
    kernelId: input.kernelId ?? null,
    kernelVersion: input.kernelVersion ?? null,
    attestationStatus: input.attestation?.status ?? "absent",
    attestationProvider: input.attestation?.provider ?? null,
    provenance: input.provenance ?? null,
    producedAt: input.producedAt ?? Date.now(),
    latencyMs: input.latencyMs ?? null,
  };

  const proofId = computeProofId(base as unknown as { [k: string]: Json });
  return { proofId, ...base };
}

/**
 * Structural guard for a {@link LedgerProof} read back from storage. Rejects a
 * blob that is not a well-formed proof so a corrupt/tampered record is never
 * surfaced as a valid proof. Does NOT recompute the hash — call {@link verifyProof}
 * for integrity.
 */
export function isLedgerProofShape(value: unknown): value is LedgerProof {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === PROOF_SCHEMA &&
    typeof v.proofId === "string" &&
    typeof v.decisionId === "string" &&
    typeof v.decision === "object" &&
    v.decision !== null &&
    typeof v.requestDigest === "string" &&
    (v.factsDigest === null || typeof v.factsDigest === "string") &&
    isAttestationStatus(v.attestationStatus) &&
    typeof v.producedAt === "number"
  );
}

/** Result of {@link verifyProof}: record-integrity check only. */
export interface ProofVerification {
  /** True iff the recomputed id matches the stored `proofId`. */
  readonly valid: boolean;
  /** The id recomputed from the proof's current content. */
  readonly expectedProofId: string;
  /** The id stored on the proof. */
  readonly actualProofId: string;
}

/**
 * Recompute a proof's stable id from its content and compare to the stored id.
 *
 * A `valid: true` result means the proof RECORD is internally consistent and was
 * not altered since it was built. It does NOT assert the underlying facts are true
 * or that any attestation passed — read {@link LedgerProof.attestationStatus} for
 * that, and treat provenance as structural-only (see provenance.ts).
 */
export function verifyProof(proof: LedgerProof): ProofVerification {
  const expectedProofId = computeProofId(proof as unknown as { [k: string]: Json });
  return {
    valid: expectedProofId === proof.proofId,
    expectedProofId,
    actualProofId: proof.proofId,
  };
}

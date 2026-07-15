/**
 * @ramp/ledger — proof-verification.ts (first-class INDEPENDENT re-verification)
 *
 * Verification is a distinct trust boundary from persistence: it NEVER trusts the
 * stored proof bytes. Given a decision record it recomputes the proof's stable id
 * from the proof's *current* content (via {@link verifyProof}) and only reports
 * `proofVerified` when that recomputation matches the stored id. A missing proof is
 * never reported as verified; a corrupt/malformed proof is reported as unverified
 * WITHOUT throwing.
 *
 * INTEGRITY, NOT TRUTH: a `proofVerified` result confirms the RECORD was not
 * altered since the proof was built. It does not assert the underlying facts are
 * real, nor that any attestation passed — see {@link LedgerProof.attestationStatus}.
 */
import { verifyProof, type LedgerProof } from "./proof.js";
import type { DecisionRecord } from "./decision-log.js";

/** Short machine reason for a verification outcome. Never a stack trace. */
export type ProofVerificationReason = "ok" | "absent" | "corrupt" | "mismatch";

/** The result of independently re-verifying the proof on a decision record. */
export interface DecisionProofVerification {
  /** True iff a proof is stored for this decision. */
  readonly proofPresent: boolean;
  /**
   * True ONLY when a proof is present AND independently recomputes to its stored
   * id. Missing/corrupt/malformed proofs are ALWAYS false.
   */
  readonly proofVerified: boolean;
  /** Recomputed id (null when the proof is absent or unverifiable). */
  readonly expectedProofId: string | null;
  /** Stored id (null when the proof is absent). */
  readonly actualProofId: string | null;
  /** Short machine reason: "ok" | "absent" | "corrupt" | "mismatch". */
  readonly reason: ProofVerificationReason;
}

/** Read the stored proofId defensively — a malformed object must never throw here. */
function readStoredProofId(proof: unknown): string | null {
  try {
    const id = (proof as { proofId?: unknown }).proofId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Independently re-verify the proof on a decision record. NEVER throws.
 *
 * - No proof stored (`record.proof == null`) → `absent` (never "verified").
 * - Proof present and it recomputes to its stored id → `ok`.
 * - Proof present but recomputes to a DIFFERENT id → `mismatch` (tampered/invalid).
 * - Proof present but {@link verifyProof} throws (malformed/corrupt content) →
 *   `corrupt`, with `actualProofId` set to the stored id when readable.
 */
export function verifyDecisionProof(
  record: Pick<DecisionRecord, "proof">,
): DecisionProofVerification {
  const proof = record.proof;
  if (proof === null || proof === undefined) {
    return {
      proofPresent: false,
      proofVerified: false,
      expectedProofId: null,
      actualProofId: null,
      reason: "absent",
    };
  }

  try {
    const result = verifyProof(proof as LedgerProof);
    return {
      proofPresent: true,
      proofVerified: result.valid,
      expectedProofId: result.expectedProofId,
      actualProofId: result.actualProofId,
      reason: result.valid ? "ok" : "mismatch",
    };
  } catch {
    // Malformed/corrupt content made recomputation throw. Surface it as an
    // honest, non-verified result — never a stack trace, never a throw.
    return {
      proofPresent: true,
      proofVerified: false,
      expectedProofId: null,
      actualProofId: readStoredProofId(proof),
      reason: "corrupt",
    };
  }
}

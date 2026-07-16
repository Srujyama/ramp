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
 * It ALSO binds the proof to the row it belongs to — see {@link verifyDecisionProof}.
 * Recomputing a proof from its own bytes proves the PROOF is intact and says
 * nothing about the decision beside it.
 *
 * INTEGRITY, NOT TRUTH: a `proofVerified` result confirms the RECORD was not
 * altered since the proof was built. It does not assert the underlying facts are
 * real, nor that any attestation passed — see {@link LedgerProof.attestationStatus}.
 */
import { verifyProof, type LedgerProof } from "./proof.js";
import { digestOf, type Json } from "./canonical-hash.js";
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
 * - Proof present, it recomputes to its stored id, AND it commits to the facts
 *   stored beside it → `ok`.
 * - Proof present but recomputes to a DIFFERENT id → `mismatch` (tampered/invalid).
 * - Proof present and internally intact, but the row's `facts` do not match the
 *   `factsDigest` the proof commits to → `mismatch`. See below.
 * - Proof present but {@link verifyProof} throws (malformed/corrupt content) →
 *   `corrupt`, with `actualProofId` set to the stored id when readable.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACTS BINDING IS HERE AND NOT SOMEBODY ELSE'S JOB
 * ---------------------------------------------------------------------------
 * Recomputing a proof from its own bytes proves the PROOF is intact. It proves
 * nothing about the decision row sitting next to it. Editing `facts_json` and
 * leaving the proof alone used to pass BOTH shipped verifiers:
 *
 *   - `verifyChain` links on `H(prev || proof_id || decision_id)` and never reads
 *     row content, so a facts edit is invisible to it BY DESIGN.
 *   - `verifyProof` recomputed this proof's id from this proof's bytes — which the
 *     tamper did not touch — and returned `ok`.
 *
 * Both were correct about their own contract, and the record was still a lie: you
 * could rewrite the facts a payment was judged on to anything at all, and the
 * console would render a green "Proof valid" chip beside it. The gap was the SEAM
 * between two verifiers, which is the one place neither owns.
 *
 * The evidence was always there — `buildProof` commits `factsDigest` precisely so
 * the facts cannot be swapped — but nothing compared the two sides. This does. It
 * is `mismatch` rather than a new reason because that is exactly what it means:
 * the record was altered after sealing, and every caller already treats `mismatch`
 * as tampered.
 */
export function verifyDecisionProof(
  record: Pick<DecisionRecord, "proof"> & Partial<Pick<DecisionRecord, "facts">>,
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
    if (!result.valid) {
      return {
        proofPresent: true,
        proofVerified: false,
        expectedProofId: result.expectedProofId,
        actualProofId: result.actualProofId,
        reason: "mismatch",
      };
    }

    // The proof is internally intact. Now: is it a proof about THIS row?
    //
    // Two conditions, both deliberate:
    //
    //  - `"facts" in record` — `purchase.ts` verifies with `{ proof }` alone
    //    mid-lifecycle. This must be a strict improvement, never a false tampering
    //    report against a caller that simply did not hand us the row.
    //
    //  - `committed !== null` — a proof built with no facts commits no
    //    `factsDigest`, and a claim never made cannot be broken. Reporting such a
    //    record as tampered would be a lie about WHICH thing is wrong: nothing was
    //    altered, the proof just never covered the facts. That is a real weakness,
    //    but it is a property of that proof, and calling it "altered" would bury
    //    genuine tampering under false positives.
    //
    // This is not a way out for an attacker. `factsDigest` is part of the proof's
    // own hashed content, so nulling it to dodge this check changes the proofId and
    // `verifyProof` above already returned `mismatch`. Every proof the production
    // path builds (purchase.ts, the hook, the seeders) commits the facts it judged.
    if ("facts" in record) {
      const committed = (proof as LedgerProof).factsDigest ?? null;
      if (committed !== null) {
        const facts = record.facts;
        const actual = facts == null ? null : digestOf(facts as unknown as Json);
        if (committed !== actual) {
          return {
            proofPresent: true,
            proofVerified: false,
            expectedProofId: result.expectedProofId,
            actualProofId: result.actualProofId,
            reason: "mismatch",
          };
        }
      }
    }

    return {
      proofPresent: true,
      proofVerified: true,
      expectedProofId: result.expectedProofId,
      actualProofId: result.actualProofId,
      reason: "ok",
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

/**
 * @ramp/attestation — K-of-N threshold (quorum) attestation
 *
 * ============================================================================
 * THE PROBLEM THIS SOLVES — the single point of trust
 * ============================================================================
 * A single-notary attestation roots the whole provability chain in ONE key: if
 * that one notary is compromised (or dishonest), an attacker can mint a signature
 * the keyring accepts, and every binding check downstream is reasoning about a lie
 * that was signed correctly. "We proved the decision follows from the facts" is
 * only as strong as "the facts are true", and here one key decides one of them.
 *
 * A QUORUM attestation removes the single point of trust: the SAME statement must
 * be independently signed by at least `threshold` DISTINCT notaries from the
 * trusted keyring. Compromising one notary buys one signature; a 2-of-3 quorum
 * still rejects it. The attacker now has to compromise K independent parties, not
 * one — which is the entire reason threshold signatures exist.
 *
 * ============================================================================
 * WHY THIS REUSES `verifyAttestation` RATHER THAN REIMPLEMENTING IT
 * ============================================================================
 * Every property a single attestation must have — a known-notary signature over
 * the canonical bytes, freshness, and binding to the authoritative amount / domain
 * / invoice — a quorum member must have too. So each signature is checked by the
 * SAME `verifyAttestation` the single-sig path uses; there is no second, weaker
 * verifier to drift. Quorum adds exactly one thing on top: COUNT the distinct
 * notaries whose signature fully verified, and require at least `threshold`.
 *
 * Pure and total, like everything on the enforcement path: any input shape yields
 * a verdict, never a throw.
 */
import type { KeyObject } from "node:crypto";
import {
  verifyAttestation,
  signAttestation,
  type Attestation,
  type AttestedStatement,
  type AttestationFailure,
  type VerifyOptions,
} from "./attestation.js";

/** One notary's signature over a shared statement. */
export interface NotarySignature {
  /** Which notary key signed. Selects a key; grants no authority by itself. */
  readonly notaryKeyId: string;
  /** Base64 Ed25519 signature over `signingBytes(statement)`. */
  readonly signature: string;
}

/**
 * A quorum attestation: ONE statement, signed independently by several notaries.
 *
 * There is exactly one `statement`, so every signature is necessarily over the
 * same bytes — an attacker cannot have notary A sign "$100 to acme.example.com"
 * and notary B sign "$9000 to attacker.example" and pass them off as one quorum.
 */
export interface QuorumAttestation {
  readonly statement: AttestedStatement;
  readonly signatures: readonly NotarySignature[];
}

/** Options for {@link verifyQuorum}: the single-sig options plus a threshold. */
export interface VerifyQuorumOptions extends VerifyOptions {
  /**
   * Minimum number of DISTINCT trusted notaries that must each fully verify. Must
   * be a positive integer. `threshold: 1` is exactly the single-notary policy.
   */
  readonly threshold: number;
}

/** Quorum reached: the statement is authentic (K distinct notaries) AND bound. */
export interface QuorumVerified {
  readonly verified: true;
  readonly statement: AttestedStatement;
  /** The distinct notary key ids whose signatures counted toward the quorum. */
  readonly signers: readonly string[];
  readonly threshold: number;
}

/** Quorum NOT reached (or a per-signature check failed for too many). */
export interface QuorumRejected {
  readonly verified: false;
  readonly code: AttestationFailure | "insufficient_quorum" | "bad_threshold";
  readonly reason: string;
  /** The distinct notaries that DID verify (may be below threshold). */
  readonly validSigners: readonly string[];
}

export type QuorumResult = QuorumVerified | QuorumRejected;

/** Structural guard. Total: any shape yields a boolean, never a throw. */
function isQuorumAttestation(value: unknown): value is QuorumAttestation {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Record<string, unknown>;
  if (typeof q.statement !== "object" || q.statement === null) return false;
  if (!Array.isArray(q.signatures)) return false;
  return q.signatures.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Record<string, unknown>).notaryKeyId === "string" &&
      typeof (s as Record<string, unknown>).signature === "string",
  );
}

/**
 * Verify a quorum attestation: the statement must be independently signed by at
 * least `threshold` DISTINCT trusted notaries, AND (as for any attestation) bind
 * to the authoritative amount / domain / invoice and be fresh.
 *
 * Each signature is delegated to {@link verifyAttestation}, so it inherits every
 * authenticity, freshness, and binding check with no second implementation to
 * drift. A notary is counted at most once, so N copies of one notary's signature
 * are still one signer — the defence against faking breadth with duplication.
 */
export function verifyQuorum(
  attestation: unknown,
  opts: VerifyQuorumOptions,
): QuorumResult {
  if (!Number.isInteger(opts.threshold) || opts.threshold < 1) {
    return {
      verified: false,
      code: "bad_threshold",
      reason: `threshold must be a positive integer, got ${String(opts.threshold)}`,
      validSigners: [],
    };
  }
  if (!isQuorumAttestation(attestation)) {
    return {
      verified: false,
      code: "malformed",
      reason: "not a well-formed QuorumAttestation",
      validSigners: [],
    };
  }

  const validSigners = new Set<string>();
  let lastFailure: { code: AttestationFailure; reason: string } | null = null;

  for (const sig of attestation.signatures) {
    // Already counted this notary — duplication cannot inflate the count.
    if (validSigners.has(sig.notaryKeyId)) continue;
    const single: Attestation = {
      statement: attestation.statement,
      notaryKeyId: sig.notaryKeyId,
      signature: sig.signature,
    };
    const r = verifyAttestation(single, opts);
    if (r.verified) {
      validSigners.add(sig.notaryKeyId);
    } else {
      // Remember the last real failure so a rejected quorum can say WHY — e.g. a
      // statement that binds to the wrong amount fails every signature identically,
      // and reporting "insufficient_quorum" alone would hide the real cause.
      lastFailure = { code: r.code, reason: r.reason };
    }
  }

  if (validSigners.size >= opts.threshold) {
    return {
      verified: true,
      statement: attestation.statement,
      signers: [...validSigners],
      threshold: opts.threshold,
    };
  }

  // If NObody verified and there is a shared statement-level failure (bad binding,
  // stale, tampered), surface that; otherwise it is genuinely a count shortfall.
  if (validSigners.size === 0 && lastFailure !== null) {
    return {
      verified: false,
      code: lastFailure.code,
      reason: lastFailure.reason,
      validSigners: [],
    };
  }
  return {
    verified: false,
    code: "insufficient_quorum",
    reason: `only ${validSigners.size} distinct notary signature(s) verified; ${opts.threshold} required`,
    validSigners: [...validSigners],
  };
}

/**
 * Mint a quorum attestation by signing one statement with several notary keys.
 * For the demo and tests — a real quorum is assembled from signatures produced by
 * separate parties, never all held in one place.
 */
export function signQuorum(
  statement: AttestedStatement,
  notaries: ReadonlyArray<{ readonly privateKey: KeyObject; readonly notaryKeyId: string }>,
): QuorumAttestation {
  const signatures: NotarySignature[] = notaries.map((n) => {
    const { signature } = signAttestation(statement, n.privateKey, n.notaryKeyId);
    return { notaryKeyId: n.notaryKeyId, signature };
  });
  return { statement, signatures };
}

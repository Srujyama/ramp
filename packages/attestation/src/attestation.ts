/**
 * @ramp/attestation — PILLAR 4: TLSNotary-style invoice attestation
 *
 * ============================================================================
 * WHAT THIS IS, AND HONESTLY WHAT IT IS NOT
 * ============================================================================
 * The pitch's claim is: "TLSNotary proves the invoice bytes came from the real
 * vendor's TLS session, rather than from the agent's summary of it." That claim
 * is about a DIFFERENT GUARANTEE than a 3-way match, and the distinction is the
 * point:
 *
 *   - A 3-way match (PO / invoice / receiving) checks three documents AGAINST
 *     EACH OTHER. If all three are spoofed together, it passes. Consistency is
 *     not authenticity.
 *   - An attestation binds the invoice bytes to a TLS session with a named
 *     server. A forger must break the vendor's TLS or steal a notary key — not
 *     merely author three consistent PDFs.
 *
 * WHAT THIS PACKAGE IMPLEMENTS: the verification half of that scheme, with real
 * cryptography. Ed25519 signatures (node:crypto), canonical domain-separated
 * encoding, a notary keyring, and binding checks against the authoritative
 * vendor registry. Forge a field and verification fails; sign with an unknown
 * key and verification fails.
 *
 * WHAT THIS PACKAGE IS NOT: the actual TLSNotary protocol. Real TLSNotary runs
 * a multi-party computation between the client and a notary, so that the notary
 * co-signs a TLS transcript WITHOUT the client ever holding the session keys
 * alone and WITHOUT the notary seeing the plaintext. We do not implement the
 * MPC. Here, a notary observes and signs a statement; you are trusting the
 * notary's honesty about the session, whereas real TLSNotary reduces that to a
 * cryptographic guarantee.
 *
 * The difference is real and we state it plainly, in the package that would be
 * most tempting to overstate. This layer's actual, defensible guarantee is:
 *
 *     "These invoice bytes, this amount, and this vendor domain were signed
 *      together by a notary we already trusted, and none of it has been altered
 *      since — and that binding is checked before the money moves."
 *
 * That is strictly stronger than trusting the agent's narration, and strictly
 * weaker than real TLSNotary. Both halves of that sentence matter. A project
 * whose thesis is provability does not get to hand-wave its own proofs.
 * Swapping in a real TLSNotary verifier means replacing `verifySignature` and
 * the `transcriptCommitment` semantics; every binding check below survives.
 */
import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { signingBytes } from "./canonical.js";

/** Current attestation format version. Part of the signed statement. */
export const ATTESTATION_VERSION = 1 as const;

/**
 * The claim a notary signs: what was served, by whom, when.
 *
 * Every field is INSIDE the signature. A field outside the signature is a field
 * an attacker can rewrite in transit, so there is deliberately nothing security
 * relevant on the envelope except the key id (which only selects a key — and
 * selecting the wrong key makes verification fail, not succeed).
 */
export interface AttestedStatement {
  readonly version: typeof ATTESTATION_VERSION;
  /**
   * The TLS server the bytes were served by (SNI / certificate subject), e.g.
   * "acme.example.com". Checked against the vendor's REGISTERED domain from the
   * ledger — an attestation for a domain we never registered proves nothing
   * about the vendor we are being asked to pay.
   */
  readonly serverDomain: string;
  /** sha256 (hex) of the invoice document bytes exactly as served. */
  readonly invoiceDigest: string;
  /**
   * Commitment to the TLS session transcript.
   *
   * In real TLSNotary this is a cryptographic commitment produced by the MPC. In
   * this implementation it is an opaque notary-supplied handle: it pins WHICH
   * session was observed and is covered by the signature, but on its own it
   * proves nothing without the notary's honesty. See the file header.
   */
  readonly transcriptCommitment: string;
  /** RFC 3339 UTC instant the notarisation happened. Drives the freshness check. */
  readonly notarizedAt: string;
  /** Amount as served by the vendor, integer whole units (the repo-wide invariant). */
  readonly amount: number;
  /** ISO 4217 currency as served, e.g. "USD". */
  readonly currency: string;
  /** The vendor's own invoice reference as served. */
  readonly invoiceRef: string;
}

/** A signed attestation: the statement plus the notary's signature over it. */
export interface Attestation {
  /** Which notary key signed. Selects a key; grants no authority by itself. */
  readonly notaryKeyId: string;
  /** The signed claim. */
  readonly statement: AttestedStatement;
  /** Base64 Ed25519 signature over `signingBytes(statement)`. */
  readonly signature: string;
}

/** Machine-readable reasons an attestation can fail. Stable; used in audit output. */
export type AttestationFailure =
  | "malformed"
  | "unknown_notary"
  | "bad_signature"
  | "version_mismatch"
  | "invoice_digest_mismatch"
  | "domain_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "expired"
  | "future_dated";

/** Verification succeeded: the statement is authentic AND binds to the request. */
export interface AttestationVerified {
  readonly verified: true;
  readonly statement: AttestedStatement;
  readonly notaryKeyId: string;
}

/** Verification failed. The verdict that reaches Facts is simply `false`. */
export interface AttestationRejected {
  readonly verified: false;
  readonly code: AttestationFailure;
  readonly reason: string;
}

export type AttestationResult = AttestationVerified | AttestationRejected;

/**
 * What the attestation must BIND to. These come from authoritative sources —
 * the request's structured args and the ledger's vendor registry — never from
 * the attestation itself. An attestation that is internally consistent but
 * describes a different payment than the one being authorised is worthless, so
 * we check it against the world rather than against itself.
 */
export interface AttestationExpectation {
  /** sha256 of the invoice bytes WE hold. */
  readonly invoiceDigest: string;
  /** The vendor's registered domain, from the ledger. Null if unregistered. */
  readonly registeredDomain: string | null;
  /** The amount being authorised, from the structured request. */
  readonly amount: number;
  /** The currency being authorised, from the structured request. */
  readonly currency: string;
}

/** Options for {@link verifyAttestation}. */
export interface VerifyOptions {
  /** Trusted notary public keys, by key id. An unknown id is a rejection. */
  readonly keyring: ReadonlyMap<string, KeyObject>;
  /** What the statement must bind to (authoritative values). */
  readonly expect: AttestationExpectation;
  /**
   * Current time in epoch milliseconds — INJECTED, never read from the clock in
   * here.
   *
   * This keeps `verifyAttestation` a pure function of its inputs: same inputs,
   * same verdict, testable without freezing time. It also keeps the repo's
   * determinism claim honest. The kernel promises "same Facts -> same Decision",
   * and `attestation_present` is a Fact. Freshness genuinely depends on wall
   * time, so the clock read has to live SOMEWHERE — it lives at the caller (the
   * hook), out in the fact-gathering layer where reading the world is expected,
   * alongside the DB reads. Only the resulting boolean crosses into the kernel.
   */
  readonly now: number;
  /** Max age of a notarisation, seconds. Default 15 minutes. */
  readonly maxAgeSeconds?: number;
  /**
   * Tolerance for a notary clock running ahead of ours, seconds. Default 60.
   * Without it, ordinary clock skew rejects perfectly good attestations; with it
   * too large, an attacker can post-date. A minute is the usual compromise.
   */
  readonly clockSkewSeconds?: number;
}

/** sha256 (hex) of invoice bytes. The one true way to digest an invoice here. */
export function digestInvoice(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Structural validation. Total: any input shape yields a boolean, never a throw. */
function isAttestation(value: unknown): value is Attestation {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  if (typeof a.notaryKeyId !== "string" || typeof a.signature !== "string") return false;
  const s = a.statement;
  if (typeof s !== "object" || s === null) return false;
  const st = s as Record<string, unknown>;
  return (
    typeof st.serverDomain === "string" &&
    typeof st.invoiceDigest === "string" &&
    typeof st.transcriptCommitment === "string" &&
    typeof st.notarizedAt === "string" &&
    typeof st.amount === "number" &&
    typeof st.currency === "string" &&
    typeof st.invoiceRef === "string" &&
    typeof st.version === "number"
  );
}

/**
 * Constant-time-ish string equality for non-secret comparisons.
 *
 * Digests and domains are public values, so timing is not a real concern here;
 * this is a plain equality with an explicit name so reviewers don't have to
 * wonder whether it should have been `timingSafeEqual`. (Signature verification
 * itself is handled inside node:crypto, which does the right thing.)
 */
function eq(a: string, b: string): boolean {
  return a === b;
}

/**
 * Verify an attestation: authentic (signed by a known notary, unaltered) AND
 * bound to the payment actually being authorised.
 *
 * Order matters. Authenticity is checked BEFORE any binding check, so we never
 * reason about the contents of a statement we haven't established is genuine.
 * Reasoning about unverified data is how verifiers grow bugs.
 *
 * Pure: no clock, no I/O, no randomness. Total: malformed input is a rejection,
 * never a throw — this runs on the enforcement path, where a throw is a DoS.
 */
export function verifyAttestation(
  attestation: unknown,
  opts: VerifyOptions,
): AttestationResult {
  const maxAgeSeconds = opts.maxAgeSeconds ?? 15 * 60;
  const clockSkewSeconds = opts.clockSkewSeconds ?? 60;

  // ---- 0. shape --------------------------------------------------------
  if (!isAttestation(attestation)) {
    return { verified: false, code: "malformed", reason: "not a well-formed Attestation" };
  }
  const { statement, notaryKeyId, signature } = attestation;

  if (statement.version !== ATTESTATION_VERSION) {
    return {
      verified: false,
      code: "version_mismatch",
      reason: `attestation version ${statement.version} != supported ${ATTESTATION_VERSION}`,
    };
  }

  // ---- 1. authenticity: is this from a notary we already trust? --------
  const publicKey = opts.keyring.get(notaryKeyId);
  if (!publicKey) {
    // The keyring IS the trust decision. An attacker can mint a perfectly valid
    // signature with their own key; it fails here, because the question is not
    // "is this signed?" but "is this signed by someone we decided to trust?"
    return {
      verified: false,
      code: "unknown_notary",
      reason: `notary key id "${notaryKeyId}" is not in the trusted keyring`,
    };
  }

  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(
      null, // Ed25519 selects its own hash; null is correct here.
      signingBytes(statement),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    // Malformed base64, wrong key type, etc. A failure to verify is a rejection.
    signatureOk = false;
  }
  if (!signatureOk) {
    return {
      verified: false,
      code: "bad_signature",
      reason: "signature does not verify over the canonical statement bytes",
    };
  }

  // ---- 2. freshness ----------------------------------------------------
  const notarizedMs = Date.parse(statement.notarizedAt);
  if (Number.isNaN(notarizedMs)) {
    return {
      verified: false,
      code: "malformed",
      reason: `notarizedAt "${statement.notarizedAt}" is not a parseable RFC 3339 instant`,
    };
  }
  const ageSeconds = (opts.now - notarizedMs) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    // Replay defence: a genuine attestation for a genuine past invoice must not
    // authorise a payment forever.
    return {
      verified: false,
      code: "expired",
      reason: `notarised ${Math.round(ageSeconds)}s ago, older than the ${maxAgeSeconds}s limit`,
    };
  }
  if (ageSeconds < -clockSkewSeconds) {
    return {
      verified: false,
      code: "future_dated",
      reason: `notarised ${Math.round(-ageSeconds)}s in the future, beyond ${clockSkewSeconds}s skew tolerance`,
    };
  }

  // ---- 3. binding: does this describe THE payment being authorised? ----
  // Authentic but unbound is worthless: a real attestation for last week's $5
  // stapler invoice must not authorise today's $50,000 transfer.
  const { expect } = opts;

  if (!eq(statement.invoiceDigest, expect.invoiceDigest)) {
    return {
      verified: false,
      code: "invoice_digest_mismatch",
      reason: "the attested invoice digest is not the digest of the invoice we hold",
    };
  }
  if (expect.registeredDomain === null) {
    return {
      verified: false,
      code: "domain_mismatch",
      reason: "the vendor has no registered domain, so no attestation can bind to it",
    };
  }
  if (!eq(statement.serverDomain, expect.registeredDomain)) {
    // The crux of "match != authenticate". An attacker who controls
    // invoices.acme-corp-billing.example can serve a perfectly self-consistent
    // invoice over real TLS and get it genuinely notarised. It fails HERE,
    // because that is not the domain the registry says Acme is.
    return {
      verified: false,
      code: "domain_mismatch",
      reason: `attested server "${statement.serverDomain}" is not the vendor's registered domain "${expect.registeredDomain}"`,
    };
  }
  if (statement.amount !== expect.amount) {
    return {
      verified: false,
      code: "amount_mismatch",
      reason: `attested amount ${statement.amount} != requested amount ${expect.amount}`,
    };
  }
  if (!eq(statement.currency, expect.currency)) {
    return {
      verified: false,
      code: "currency_mismatch",
      reason: `attested currency ${statement.currency} != requested ${expect.currency}`,
    };
  }

  return { verified: true, statement, notaryKeyId };
}

/**
 * Sign a statement as a notary. Used by tests and by the demo notary.
 *
 * In production the notary is a separate party holding its own key; this exists
 * so the repo can produce genuine signatures to verify against, rather than
 * faking the crypto in tests.
 */
export function signAttestation(
  statement: AttestedStatement,
  privateKey: KeyObject,
  notaryKeyId: string,
): Attestation {
  const signature = cryptoSign(null, signingBytes(statement), privateKey).toString("base64");
  return { notaryKeyId, statement, signature };
}

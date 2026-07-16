/**
 * @ramp/provenance — gate signatures over decision bundles
 *
 * ============================================================================
 * WHAT SIGNING ADDS — AND THE THREAT MODEL IT DOES *NOT* COVER
 * ============================================================================
 * Re-derivation already catches a forger who edits a bundle: flip a deny to an
 * allow, re-seal every digest so integrity checks pass, and the verifier still
 * catches it, because the recorded decision no longer follows from the recorded
 * facts. You cannot reseal your way out of arithmetic.
 *
 * But a competent forger doesn't edit a bundle — they write a NEW, internally
 * perfect one. Facts that genuinely allow, a decision that genuinely follows,
 * digests that genuinely match. Every check in the verifier passes, because
 * there is nothing wrong with it *except that it never happened*. Re-derivation
 * proves a bundle is INTERNALLY COHERENT. It cannot prove the gate produced it.
 *
 * A signature is what says "the gate produced this." The gate signs its bundle
 * digest with a key the disk does not have, so an attacker who can write files
 * can still write garbage — they just can't write garbage that VERIFIES.
 *
 * ============================================================================
 * BE PRECISE ABOUT WHO THIS STOPS
 * ============================================================================
 * This buys exactly one thing: it separates DISK COMPROMISE from GATE
 * COMPROMISE. Those are different attackers and they are worth distinguishing:
 *
 *   - Attacker owns the bundle directory / the DB / the backups, but not the
 *     gate's key: STOPPED. They cannot mint a bundle that verifies. This is the
 *     common case — audit artifacts get copied, synced, and archived far more
 *     widely than the process that produced them, and every one of those copies
 *     is a place to tamper.
 *   - Attacker owns the GATE (code execution where the key lives): NOT STOPPED,
 *     and nothing here pretends otherwise. They have the key, so they sign
 *     whatever they like. Signing is not a defence against a compromised signer;
 *     no signature scheme is. What survives even then is the hash chain (a
 *     rewritten history has a different head than the one you published) — which
 *     is why the three mechanisms are separate and none replaces another.
 *
 * So: signature = authenticity ("the gate said this"), re-derivation = soundness
 * ("and it was right"), chain = completeness ("and nothing is missing"). Three
 * questions, three mechanisms, and a reader deserves to know which is which.
 *
 * ============================================================================
 * VERIFICATION REQUIRES AN OUT-OF-BAND KEY. THIS IS NOT A DETAIL.
 * ============================================================================
 * The public key must reach the auditor by a path the attacker doesn't control.
 * A key read out of the bundle proves nothing whatsoever: the forger includes
 * their own key and signs with it, and the maths works perfectly. That is why
 * `verifyBundleSignature` takes the key as a PARAMETER and there is deliberately
 * no "key" field on the bundle for it to read.
 */
import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * Domain separation tag. A signature is over `ramp.bundle.v1\n<bundleDigest>`,
 * never the bare digest — otherwise a signature the gate key produced for some
 * OTHER purpose (an attestation statement, a session token, anything that
 * happens to be 64 hex chars) could be replayed as a bundle signature.
 */
export const BUNDLE_SIGNING_DOMAIN = "ramp.bundle.v1";

/** The signature attached to a bundle. */
export interface GateSignature {
  /** Which gate key signed. Selects a key; grants no authority by itself. */
  readonly gateKeyId: string;
  /** Base64 Ed25519 signature over `signingBytes(bundleDigest)`. */
  readonly signature: string;
}

/** The exact bytes signed and verified. Both sides call THIS — there is no second way. */
export function bundleSigningBytes(bundleDigest: string): Buffer {
  return Buffer.from(`${BUNDLE_SIGNING_DOMAIN}\n${bundleDigest}`, "utf8");
}

/**
 * Sign a sealed bundle's digest as the gate.
 *
 * Signs the `bundleDigest`, not the whole bundle: the digest already commits to
 * every field (it is computed over all of them), so signing it signs all of them
 * — and it keeps the signed bytes a fixed 79 characters regardless of how large
 * the provenance graph grows.
 */
export function signBundleDigest(
  bundleDigest: string,
  privateKey: KeyObject,
  gateKeyId: string,
): GateSignature {
  return {
    gateKeyId,
    signature: cryptoSign(null, bundleSigningBytes(bundleDigest), privateKey).toString("base64"),
  };
}

/** Why a signature check failed. */
export type SignatureFailure =
  | "absent"
  | "unknown_key"
  | "bad_signature"
  | "malformed";

export interface SignatureVerification {
  readonly verified: boolean;
  readonly code: SignatureFailure | "ok";
  readonly detail: string;
  /** The key id that signed, when the signature verified. */
  readonly gateKeyId: string | null;
}

/**
 * Verify a bundle's gate signature against a keyring supplied OUT OF BAND.
 *
 * Total: malformed input is a verdict, never a throw.
 *
 * An absent signature is reported as `absent` rather than as a failure, because
 * whether that's acceptable is the CALLER's policy, not this function's: bundles
 * written before signing existed are legitimately unsigned, and quietly treating
 * them as forged would be as wrong as quietly treating them as genuine.
 */
export function verifyBundleSignature(
  bundleDigest: string,
  signature: unknown,
  keyring: ReadonlyMap<string, KeyObject>,
): SignatureVerification {
  if (signature === undefined || signature === null) {
    return { verified: false, code: "absent", detail: "the bundle is not signed", gateKeyId: null };
  }
  if (
    typeof signature !== "object" ||
    typeof (signature as GateSignature).gateKeyId !== "string" ||
    typeof (signature as GateSignature).signature !== "string"
  ) {
    return { verified: false, code: "malformed", detail: "not a well-formed GateSignature", gateKeyId: null };
  }
  const sig = signature as GateSignature;

  const key = keyring.get(sig.gateKeyId);
  if (!key) {
    // The keyring IS the trust decision. An attacker signs perfectly well with
    // their own key; it fails here because the question is not "is this signed?"
    // but "is this signed by a key we decided, in advance, to trust?"
    return {
      verified: false,
      code: "unknown_key",
      detail: `gate key "${sig.gateKeyId}" is not in the trusted keyring`,
      gateKeyId: null,
    };
  }

  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      bundleSigningBytes(bundleDigest),
      key,
      Buffer.from(sig.signature, "base64"),
    );
  } catch {
    ok = false;
  }

  return ok
    ? { verified: true, code: "ok", detail: "signed by a trusted gate key", gateKeyId: sig.gateKeyId }
    : {
        verified: false,
        code: "bad_signature",
        detail: "the signature does not verify over this bundle digest",
        gateKeyId: null,
      };
}

/**
 * Derive the DEMO gate keypair from a published constant.
 *
 * Same reasoning as @ramp/attestation's demo notary, and the same lesson learned
 * the hard way: a committed PEM trips every secret scanner forever and looks
 * exactly like a production credential, which invites someone to follow the
 * pattern with a real one. Deriving from a constant in plain sight keeps the demo
 * reproducible while making the key worthless BY CONSTRUCTION rather than by
 * policy — you can regenerate it by reading this file, which is the point.
 *
 * A real deployment holds the gate key in an HSM/KMS. The auditor only ever needs
 * the PUBLIC half.
 */
const DEMO_GATE_SEED_PHRASE = "ramp.demo.gate.v1 — public by design, worthless by construction";
const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/** Key id of the demo gate. Never trust this id in production. */
export const DEMO_GATE_KEY_ID = "gate_demo_ed25519_1";

/** The demo gate's PRIVATE key. The verifier never needs this. */
export function demoGatePrivateKey(): KeyObject {
  const seed = createHash("sha256").update(DEMO_GATE_SEED_PHRASE, "utf8").digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The demo gate's PUBLIC key — the only half an auditor needs. */
export function demoGatePublicKey(): KeyObject {
  return createPublicKey(demoGatePrivateKey());
}

/** The demo keyring: exactly one gate key. */
export function demoGateKeyring(): ReadonlyMap<string, KeyObject> {
  return new Map([[DEMO_GATE_KEY_ID, demoGatePublicKey()]]);
}

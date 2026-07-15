/**
 * @ramp/attestation — the notary keyring
 *
 * The keyring is where trust is DECIDED. Everything else in this package is
 * mechanism; this is policy.
 *
 * It matters that these two are separate. `verifyAttestation` can tell you "this
 * signature is mathematically valid over these bytes" — a fact about arithmetic,
 * true of any signature by any key, including the attacker's freshly-minted one.
 * The security question is never "is this signed?" but "is this signed by
 * someone we decided, in advance and out of band, to trust?" The keyring is that
 * decision, written down. An empty keyring verifies nothing, which is the
 * correct fail-closed default.
 */
import { createHash, createPublicKey, createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** Key id of the demo notary. Present ONLY in the seeded demo environment. */
export const DEMO_NOTARY_KEY_ID = "notary_demo_ed25519_1";

/**
 * ============================================================================
 * THE DEMO NOTARY KEY IS DERIVED, NOT STORED. HERE IS WHY.
 * ============================================================================
 * The demo needs a notary keypair that is:
 *   (a) REPRODUCIBLE — anyone who clones the repo gets byte-identical
 *       signatures, and `pnpm test` does not depend on fresh entropy; and
 *   (b) OBVIOUSLY NOT A SECRET — this is a fictional org, a fictional vendor,
 *       and fake money. Anyone may mint attestations this keyring accepts. That
 *       is the point: you should be able to forge one and watch a binding check
 *       reject it.
 *
 * The first instinct was to paste a PKCS#8 private-key PEM into this file. It
 * worked, and it was wrong, and GitGuardian was right to fail the build over it:
 *
 *   1. A committed PKCS#8 private-key block trips every secret scanner, forever.
 *      Suppressing that alarm teaches everyone to click through the next one —
 *      including the real one.
 *   2. A PEM is copy-pasteable. It has exactly the shape of a production
 *      credential, so it invites someone to follow the pattern with a real key.
 *
 * Deriving the key from a PUBLISHED CONSTANT keeps both properties and drops
 * both problems. The seed below is a hash of a fixed string sitting in plain
 * sight; there is no credential literal in the repository, and nothing here can
 * be mistaken for one. The key is worthless by construction rather than by
 * policy — you can regenerate it from this file, which is precisely the point.
 *
 * A REAL deployment MUST:
 *   - hold the notary private key in an HSM / KMS, never in a repo, and never on
 *     the machine running the gate (the gate only ever needs the PUBLIC key);
 *   - distribute public keys out of band, pinned, with an expiry and rotation
 *     plan (`keyringFrom` takes several keys precisely so rotation is possible);
 *   - never put this key id in the keyring. `productionKeyring()` refuses it.
 */
const DEMO_NOTARY_SEED_PHRASE = "ramp.demo.notary.v1 — public by design, worthless by construction";

/**
 * DER prefix for an Ed25519 PKCS#8 private key, per RFC 8410. An Ed25519 private
 * key IS its 32-byte seed; this header is the only thing standing between a seed
 * and a `KeyObject`, so we can derive rather than store.
 */
const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/** Deterministically derive the demo notary's private key from the seed phrase. */
function derivedDemoPrivateKey(): KeyObject {
  const seed = createHash("sha256").update(DEMO_NOTARY_SEED_PHRASE, "utf8").digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The demo notary's PUBLIC key — the only half a verifier ever needs. */
export function demoNotaryPublicKey(): KeyObject {
  return createPublicKey(derivedDemoPrivateKey());
}

/**
 * The demo notary's PRIVATE key, for the notary simulator and tests.
 *
 * The gate NEVER needs this. If you find yourself importing it from the hook or
 * from anything on the enforcement path, something has gone wrong: a verifier
 * that can sign is a verifier that can forge what it verifies.
 */
export function demoNotaryPrivateKey(): KeyObject {
  return derivedDemoPrivateKey();
}

/**
 * Build a keyring from `keyId -> PEM public key`. Throws on an unparseable PEM:
 * a keyring is built once at startup, and a malformed trusted key is a
 * configuration error that should stop the process, not a runtime surprise that
 * silently shrinks the trust set to nothing.
 */
export function keyringFrom(
  entries: Readonly<Record<string, string>>,
): ReadonlyMap<string, KeyObject> {
  const ring = new Map<string, KeyObject>();
  for (const [keyId, pem] of Object.entries(entries)) {
    try {
      ring.set(keyId, createPublicKey(pem));
    } catch (err) {
      throw new Error(
        `@ramp/attestation: notary key "${keyId}" is not a valid public key PEM: ` +
          `${(err as Error).message}`,
      );
    }
  }
  return ring;
}

/** The demo keyring: exactly one notary, the public demo key. */
export function demoKeyring(): ReadonlyMap<string, KeyObject> {
  const pem = demoNotaryPublicKey().export({ type: "spki", format: "pem" }) as string;
  return keyringFrom({ [DEMO_NOTARY_KEY_ID]: pem });
}

/**
 * A keyring for a real deployment, built from operator-supplied PEMs.
 *
 * Refuses to be empty. An empty keyring rejects every attestation, which sounds
 * safely fail-closed and is — but as a SILENT config error it means every
 * attested payment quietly fails for a reason nobody can find. Fail loudly at
 * startup instead of mysteriously at 3am.
 */
export function productionKeyring(
  entries: Readonly<Record<string, string>>,
): ReadonlyMap<string, KeyObject> {
  if (Object.keys(entries).length === 0) {
    throw new Error(
      "@ramp/attestation: productionKeyring() was given no notary keys. An empty " +
        "keyring rejects every attestation — configure at least one trusted notary.",
    );
  }
  if (DEMO_NOTARY_KEY_ID in entries) {
    throw new Error(
      `@ramp/attestation: the demo notary key ("${DEMO_NOTARY_KEY_ID}") must never be ` +
        `trusted in production — its key is derived from a constant published in this repository.`,
    );
  }
  return keyringFrom(entries);
}

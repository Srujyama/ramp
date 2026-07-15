/**
 * @ramp/provenance — sign.test.ts
 *
 * Signing exists to catch the one attack re-derivation cannot: a FABRICATED
 * bundle. A forger who edits a bundle is caught by arithmetic; a forger who
 * writes a brand-new, internally perfect one passes every structural check,
 * because nothing is wrong with it except that it never happened.
 *
 * These tests use real Ed25519 throughout — real keys, real signatures, real
 * forgery attempts. A stubbed signature proves nothing about a real verifier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  signBundleDigest,
  verifyBundleSignature,
  bundleSigningBytes,
  demoGateKeyring,
  demoGatePrivateKey,
  demoGatePublicKey,
  BUNDLE_SIGNING_DOMAIN,
  DEMO_GATE_KEY_ID,
} from "./sign.js";

const DIGEST = "a".repeat(64);

test("a genuine gate signature verifies", () => {
  const sig = signBundleDigest(DIGEST, demoGatePrivateKey(), DEMO_GATE_KEY_ID);
  const v = verifyBundleSignature(DIGEST, sig, demoGateKeyring());
  assert.equal(v.verified, true);
  assert.equal(v.gateKeyId, DEMO_GATE_KEY_ID);
});

test("THE POINT: a signature is not transferable to a different bundle", () => {
  // A fabricated bundle has a different digest, so a signature lifted from a
  // real one does not cover it. This is what stops "copy the signature onto my
  // forgery" — the cheapest attack, and the one people expect to work.
  const sig = signBundleDigest(DIGEST, demoGatePrivateKey(), DEMO_GATE_KEY_ID);
  const otherDigest = "b".repeat(64);
  const v = verifyBundleSignature(otherDigest, sig, demoGateKeyring());
  assert.equal(v.verified, false);
  assert.equal(v.code, "bad_signature");
});

test("an attacker's own key is mathematically perfect and still rejected", () => {
  // The keyring IS the trust decision. The question is never "is this signed?"
  // — anyone can sign — but "is this signed by a key we chose to trust?"
  const attacker = generateKeyPairSync("ed25519");
  const forged = signBundleDigest(DIGEST, attacker.privateKey, DEMO_GATE_KEY_ID);
  const v = verifyBundleSignature(DIGEST, forged, demoGateKeyring());
  assert.equal(v.verified, false);
  assert.equal(v.code, "bad_signature");
});

test("an unknown key id is rejected before any crypto runs", () => {
  const attacker = generateKeyPairSync("ed25519");
  const forged = signBundleDigest(DIGEST, attacker.privateKey, "gate_attacker_1");
  const v = verifyBundleSignature(DIGEST, forged, demoGateKeyring());
  assert.equal(v.verified, false);
  assert.equal(v.code, "unknown_key");
});

test("an empty keyring verifies nothing (fail-closed)", () => {
  const sig = signBundleDigest(DIGEST, demoGatePrivateKey(), DEMO_GATE_KEY_ID);
  const v = verifyBundleSignature(DIGEST, sig, new Map());
  assert.equal(v.verified, false);
  assert.equal(v.code, "unknown_key");
});

test("an absent signature is 'absent', not 'forged' — the caller decides", () => {
  // Bundles written before signing existed are legitimately unsigned. Reporting
  // them as forged would be as wrong as reporting a forgery as genuine; whether
  // unsigned is acceptable is policy, and policy belongs to the caller.
  for (const missing of [undefined, null]) {
    const v = verifyBundleSignature(DIGEST, missing, demoGateKeyring());
    assert.equal(v.verified, false);
    assert.equal(v.code, "absent");
  }
});

test("signing bytes are domain-separated", () => {
  const bytes = bundleSigningBytes(DIGEST).toString("utf8");
  assert.ok(bytes.startsWith(`${BUNDLE_SIGNING_DOMAIN}\n`));
  assert.ok(bytes.includes(DIGEST));

  // The prefix is what stops a signature the gate key made for another purpose
  // over a 64-hex string from being replayed as a bundle signature.
});

test("verifyBundleSignature is TOTAL — hostile input is a verdict, never a throw", () => {
  const hostile: unknown[] = [
    "",
    "nope",
    42,
    [],
    {},
    { gateKeyId: 1, signature: "x" },
    { gateKeyId: "a" },
    { signature: "x" },
    { gateKeyId: DEMO_GATE_KEY_ID, signature: "!!! not base64 !!!" },
    { gateKeyId: DEMO_GATE_KEY_ID, signature: "" },
    Object.create(null),
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => verifyBundleSignature(DIGEST, input, demoGateKeyring()));
    assert.equal(verifyBundleSignature(DIGEST, input, demoGateKeyring()).verified, false);
  }
});

test("the demo gate key is derived deterministically, not stored", () => {
  // Same reasoning as the demo notary: no credential literal in the repo, so no
  // scanner alarm to train people to click through, and nothing shaped like a
  // production secret to copy. Worthless BY CONSTRUCTION — you can regenerate it
  // by reading sign.ts, which is the point.
  const a = demoGatePublicKey().export({ type: "spki", format: "pem" });
  const b = demoGatePublicKey().export({ type: "spki", format: "pem" });
  assert.deepEqual(a, b);
  // And it round-trips: sign with the derived private, verify with the derived public.
  const sig = signBundleDigest(DIGEST, demoGatePrivateKey(), DEMO_GATE_KEY_ID);
  assert.equal(verifyBundleSignature(DIGEST, sig, demoGateKeyring()).verified, true);
});

test("HONEST LIMIT: signing does not stop a compromised GATE", () => {
  // Documenting the boundary as an executable claim rather than a comment.
  // An attacker with the gate's key signs whatever they like, and the signature
  // verifies — because it genuinely is the gate's key. Signing separates disk
  // compromise (stopped) from gate compromise (not stopped). No signature scheme
  // defends against a compromised signer; that is what the hash chain's
  // published head is for.
  const stolenKey = demoGatePrivateKey();
  const lie = signBundleDigest("f".repeat(64), stolenKey, DEMO_GATE_KEY_ID);
  const v = verifyBundleSignature("f".repeat(64), lie, demoGateKeyring());
  assert.equal(v.verified, true, "a stolen key produces valid signatures — by definition");
});

/**
 * @ramp/attestation — quorum (K-of-N) tests
 *
 * The property that matters: no single notary can authorise a payment. Every case
 * uses REAL, INDEPENDENT Ed25519 keys — a 2-of-3 quorum only passes when two
 * genuinely distinct trusted notaries both signed the same statement, and a lone
 * (even genuine) signature, a duplicated signature, or a forged one never reaches
 * the threshold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { digestInvoice, ATTESTATION_VERSION, type AttestedStatement, type AttestationExpectation } from "./attestation.js";
import { verifyQuorum, signQuorum } from "./quorum.js";
import { demoQuorumNotary, demoQuorumKeyring } from "./notary.js";

const INVOICE_BYTES = "ACME CORP — INVOICE inv_2026_07_0043 — Office supplies — USD 340";
const INVOICE_DIGEST = digestInvoice(INVOICE_BYTES);
const NOW = Date.parse("2026-07-15T12:00:00Z");

function heroStatement(overrides: Partial<AttestedStatement> = {}): AttestedStatement {
  return {
    version: ATTESTATION_VERSION,
    serverDomain: "acme.example.com",
    invoiceDigest: INVOICE_DIGEST,
    transcriptCommitment: "tc_demo_0001",
    notarizedAt: "2026-07-15T11:59:00Z",
    amount: 340,
    currency: "USD",
    invoiceRef: "inv_2026_07_0043",
    ...overrides,
  };
}
function heroExpectation(overrides: Partial<AttestationExpectation> = {}): AttestationExpectation {
  return { invoiceDigest: INVOICE_DIGEST, registeredDomain: "acme.example.com", amount: 340, currency: "USD", ...overrides };
}

// Three independent trusted notaries.
const N = [demoQuorumNotary(0), demoQuorumNotary(1), demoQuorumNotary(2)];
const keyring = demoQuorumKeyring(3);
const opts = (threshold: number, expect = heroExpectation(), now = NOW) => ({ keyring, expect, now, threshold });

test("2-of-3: two distinct notaries sign → quorum verifies", () => {
  const qa = signQuorum(heroStatement(), [N[0]!, N[1]!]);
  const r = verifyQuorum(qa, opts(2));
  assert.equal(r.verified, true);
  assert.ok(r.verified && r.signers.length === 2);
});

test("all three sign → verifies at threshold 3", () => {
  const qa = signQuorum(heroStatement(), [N[0]!, N[1]!, N[2]!]);
  assert.equal(verifyQuorum(qa, opts(3)).verified, true);
});

test("1-of-2: a lone GENUINE signature is not enough for a 2-quorum", () => {
  const qa = signQuorum(heroStatement(), [N[0]!]);
  const r = verifyQuorum(qa, opts(2));
  assert.equal(r.verified, false);
  assert.ok(!r.verified && r.code === "insufficient_quorum");
  assert.ok(!r.verified && r.validSigners.length === 1);
});

test("DUPLICATION cannot fake breadth: one notary's signature copied twice is one signer", () => {
  // The same genuine signature from notary 0, repeated. Two entries, one notary.
  const one = signQuorum(heroStatement(), [N[0]!]).signatures[0]!;
  const qa = { statement: heroStatement(), signatures: [one, { ...one }] };
  const r = verifyQuorum(qa, opts(2));
  assert.equal(r.verified, false);
  assert.ok(!r.verified && r.validSigners.length === 1);
});

test("a FORGED signer (attacker's own key) does not count toward the quorum", () => {
  // Notary 0 is genuine; the second signature is from an attacker key NOT in the
  // keyring, claiming a real notary's id. A 2-quorum still fails: one honest signer.
  const attacker = generateKeyPairSync("ed25519").privateKey;
  const qa = signQuorum(heroStatement(), [N[0]!, { privateKey: attacker, notaryKeyId: N[1]!.notaryKeyId }]);
  const r = verifyQuorum(qa, opts(2));
  assert.equal(r.verified, false);
  assert.ok(!r.verified && r.validSigners.length === 1 && r.validSigners[0] === N[0]!.notaryKeyId);
});

test("compromising ONE notary is not enough (the whole point)", () => {
  // The attacker holds notary 0's key and signs freely. Against a 2-of-3 policy,
  // one compromised notary yields exactly one signature — still rejected.
  const qa = signQuorum(heroStatement(), [N[0]!]);
  assert.equal(verifyQuorum(qa, opts(2)).verified, false);
});

test("unknown notary ids never count", () => {
  const stranger = demoQuorumNotary(99); // valid key, but keyring only has 0..2
  const qa = signQuorum(heroStatement(), [N[0]!, stranger]);
  const r = verifyQuorum(qa, opts(2));
  assert.equal(r.verified, false);
  assert.ok(!r.verified && r.validSigners.length === 1);
});

test("a tampered statement fails every signature (binding is per-statement)", () => {
  // Two genuine signatures, but the request is for a different amount than attested.
  const qa = signQuorum(heroStatement(), [N[0]!, N[1]!]);
  const r = verifyQuorum(qa, opts(2, heroExpectation({ amount: 9000 })));
  assert.equal(r.verified, false);
  assert.ok(!r.verified && r.code === "amount_mismatch"); // surfaced, not hidden behind insufficient_quorum
});

test("a stale quorum is rejected even with enough signers", () => {
  const qa = signQuorum(heroStatement({ notarizedAt: "2026-07-15T11:00:00Z" }), [N[0]!, N[1]!]);
  const r = verifyQuorum(qa, opts(2)); // NOW is an hour later, past the 15m window
  assert.equal(r.verified, false);
  assert.ok(!r.verified && r.code === "expired");
});

test("threshold 1 is exactly the single-notary policy", () => {
  const qa = signQuorum(heroStatement(), [N[0]!]);
  assert.equal(verifyQuorum(qa, opts(1)).verified, true);
});

test("a non-positive threshold is rejected", () => {
  const qa = signQuorum(heroStatement(), [N[0]!, N[1]!]);
  assert.ok(!verifyQuorum(qa, opts(0)).verified);
  assert.ok(!verifyQuorum(qa, opts(-1)).verified);
});

test("malformed input is a rejection, never a throw", () => {
  assert.equal(verifyQuorum(null, opts(2)).verified, false);
  assert.equal(verifyQuorum({ statement: {}, signatures: "nope" }, opts(2)).verified, false);
  assert.equal(verifyQuorum({ signatures: [] }, opts(2)).verified, false);
});

test("the demo quorum notaries are genuinely INDEPENDENT keys", () => {
  // If two "notaries" shared a key, a quorum would be theatre. Assert distinct pubkeys.
  const pems = [0, 1, 2].map((i) => demoQuorumNotary(i).publicKey.export({ type: "spki", format: "pem" }).toString());
  assert.equal(new Set(pems).size, 3);
});

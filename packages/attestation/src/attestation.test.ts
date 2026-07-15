/**
 * @ramp/attestation — tests
 *
 * A verifier is only worth what its rejections are worth, so most of this file
 * is forgery attempts. Every one uses REAL cryptography — genuine Ed25519 keys,
 * genuine signatures. Nothing is stubbed, because a stubbed verifier proves
 * nothing about a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  verifyAttestation,
  signAttestation,
  digestInvoice,
  ATTESTATION_VERSION,
  type AttestedStatement,
  type AttestationExpectation,
} from "./attestation.js";
import { canonicalJson, signingBytes, ATTESTATION_DOMAIN } from "./canonical.js";
import {
  demoKeyring,
  demoNotaryPrivateKey,
  keyringFrom,
  productionKeyring,
  DEMO_NOTARY_KEY_ID,
} from "./notary.js";

const INVOICE_BYTES = "ACME CORP — INVOICE inv_2026_07_0043 — Office supplies — USD 340";
const INVOICE_DIGEST = digestInvoice(INVOICE_BYTES);
const NOW = Date.parse("2026-07-15T12:00:00Z");

/** The honest statement the demo notary signs for the hero invoice. */
function heroStatement(overrides: Partial<AttestedStatement> = {}): AttestedStatement {
  return {
    version: ATTESTATION_VERSION,
    serverDomain: "acme.example.com",
    invoiceDigest: INVOICE_DIGEST,
    transcriptCommitment: "tc_demo_0001",
    notarizedAt: "2026-07-15T11:59:00Z", // 60s before NOW
    amount: 340,
    currency: "USD",
    invoiceRef: "inv_2026_07_0043",
    ...overrides,
  };
}

/** What the ledger + structured request say this payment must be. */
function heroExpectation(
  overrides: Partial<AttestationExpectation> = {},
): AttestationExpectation {
  return {
    invoiceDigest: INVOICE_DIGEST,
    registeredDomain: "acme.example.com",
    amount: 340,
    currency: "USD",
    ...overrides,
  };
}

function verifyHero(
  attestation: unknown,
  expect: AttestationExpectation = heroExpectation(),
  now = NOW,
) {
  return verifyAttestation(attestation, { keyring: demoKeyring(), expect, now });
}

const goodAttestation = () =>
  signAttestation(heroStatement(), demoNotaryPrivateKey(), DEMO_NOTARY_KEY_ID);

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------

test("a genuine, bound, fresh attestation verifies", () => {
  const result = verifyHero(goodAttestation());
  assert.equal(result.verified, true);
  assert.ok(result.verified && result.statement.serverDomain === "acme.example.com");
  assert.ok(result.verified && result.notaryKeyId === DEMO_NOTARY_KEY_ID);
});

// ---------------------------------------------------------------------------
// Authenticity: forgery and tampering.
// ---------------------------------------------------------------------------

test("an attestation signed by an UNTRUSTED key is rejected", () => {
  // The attacker's signature is mathematically perfect. It is rejected because
  // the question is not "is this signed?" but "is this signed by someone we
  // decided to trust?" — and the keyring is that decision.
  const attacker = generateKeyPairSync("ed25519");
  const forged = signAttestation(heroStatement(), attacker.privateKey, DEMO_NOTARY_KEY_ID);

  const result = verifyHero(forged);
  assert.equal(result.verified, false);
  assert.ok(!result.verified && result.code === "bad_signature");
});

test("an attestation naming an unknown notary key id is rejected", () => {
  const attacker = generateKeyPairSync("ed25519");
  const forged = signAttestation(heroStatement(), attacker.privateKey, "notary_attacker_1");

  const result = verifyHero(forged);
  assert.equal(result.verified, false);
  assert.ok(!result.verified && result.code === "unknown_notary");
});

test("tampering with ANY signed field breaks the signature", () => {
  // Field-by-field, so a future refactor that accidentally moves a field outside
  // the signed statement fails here rather than in production.
  const tampering: Array<Partial<AttestedStatement>> = [
    { amount: 34_000 },
    { serverDomain: "evil.example.com" },
    { invoiceDigest: digestInvoice("a different invoice") },
    { currency: "EUR" },
    { invoiceRef: "inv_forged" },
    { transcriptCommitment: "tc_forged" },
    { notarizedAt: "2026-07-15T11:59:30Z" },
  ];

  for (const patch of tampering) {
    const good = goodAttestation();
    // Keep the real signature; swap the statement underneath it.
    const tampered = { ...good, statement: { ...good.statement, ...patch } };
    const result = verifyHero(tampered, heroExpectation({ ...patch } as never));
    assert.equal(
      result.verified,
      false,
      `tampering with ${Object.keys(patch)[0]} was not detected`,
    );
    assert.ok(!result.verified && result.code === "bad_signature");
  }
});

test("a signature is not transferable to a different statement", () => {
  // Replay: take a genuine signature for the $340 invoice, staple it to a
  // $50,000 statement.
  const good = goodAttestation();
  const swapped = {
    ...good,
    statement: heroStatement({ amount: 50_000, invoiceRef: "inv_big" }),
  };
  const result = verifyHero(swapped, heroExpectation({ amount: 50_000 }));
  assert.ok(!result.verified && result.code === "bad_signature");
});

// ---------------------------------------------------------------------------
// Binding: authentic but about the WRONG payment.
// ---------------------------------------------------------------------------

test("an authentic attestation for a DIFFERENT invoice is rejected", () => {
  // Genuinely signed by the real notary, genuinely describing a real invoice —
  // just not the one being authorised. Authentic is not the same as relevant.
  const other = signAttestation(
    heroStatement({ invoiceDigest: digestInvoice("last week's stapler invoice") }),
    demoNotaryPrivateKey(),
    DEMO_NOTARY_KEY_ID,
  );
  const result = verifyHero(other);
  assert.ok(!result.verified && result.code === "invoice_digest_mismatch");
});

test("THE SPOOF BEAT: a real invoice from a lookalike domain is rejected", () => {
  // The heart of "match != authenticate". An attacker who owns
  // acme-corp-billing.example can serve a self-consistent invoice over genuine
  // TLS and have it genuinely notarised. Every document agrees with every other
  // document — a 3-way match passes. It fails HERE, because that domain is not
  // what the registry says Acme is.
  const lookalike = signAttestation(
    heroStatement({ serverDomain: "acme-corp-billing.example" }),
    demoNotaryPrivateKey(),
    DEMO_NOTARY_KEY_ID,
  );
  const result = verifyHero(lookalike);
  assert.ok(!result.verified && result.code === "domain_mismatch");
  assert.ok(!result.verified && result.reason.includes("registered domain"));
});

test("a vendor with no registered domain cannot be attested at all", () => {
  const result = verifyHero(goodAttestation(), heroExpectation({ registeredDomain: null }));
  assert.ok(!result.verified && result.code === "domain_mismatch");
});

test("an amount or currency that disagrees with the request is rejected", () => {
  const amountOff = verifyHero(goodAttestation(), heroExpectation({ amount: 341 }));
  assert.ok(!amountOff.verified && amountOff.code === "amount_mismatch");

  const currencyOff = verifyHero(goodAttestation(), heroExpectation({ currency: "EUR" }));
  assert.ok(!currencyOff.verified && currencyOff.code === "currency_mismatch");
});

// ---------------------------------------------------------------------------
// Freshness.
// ---------------------------------------------------------------------------

test("a stale attestation is rejected (replay defence)", () => {
  // A genuine attestation for a genuine invoice must not authorise forever.
  const twentyMinutesLater = NOW + 20 * 60 * 1000;
  const result = verifyHero(goodAttestation(), heroExpectation(), twentyMinutesLater);
  assert.ok(!result.verified && result.code === "expired");
});

test("a future-dated attestation beyond clock skew is rejected", () => {
  const wayEarlier = NOW - 10 * 60 * 1000;
  const result = verifyHero(goodAttestation(), heroExpectation(), wayEarlier);
  assert.ok(!result.verified && result.code === "future_dated");
});

test("small clock skew is tolerated", () => {
  // 30s of notary clock running ahead: real, and must not reject good payments.
  const slightlyEarly = NOW - 30 * 1000 - 60 * 1000;
  const result = verifyHero(goodAttestation(), heroExpectation(), slightlyEarly);
  assert.equal(result.verified, true);
});

test("an unparseable notarizedAt is malformed, not a crash", () => {
  const bad = signAttestation(
    heroStatement({ notarizedAt: "yesterday-ish" }),
    demoNotaryPrivateKey(),
    DEMO_NOTARY_KEY_ID,
  );
  const result = verifyHero(bad);
  assert.ok(!result.verified && result.code === "malformed");
});

// ---------------------------------------------------------------------------
// Totality: this runs on the enforcement path, so it must never throw.
// ---------------------------------------------------------------------------

test("verifyAttestation is TOTAL — hostile input is rejected, never thrown", () => {
  const hostile: unknown[] = [
    undefined,
    null,
    "",
    "not an attestation",
    42,
    [],
    {},
    { notaryKeyId: 1, statement: {}, signature: "x" },
    { notaryKeyId: "a", statement: null, signature: "x" },
    { notaryKeyId: DEMO_NOTARY_KEY_ID, statement: heroStatement(), signature: "!!!not base64!!!" },
    { notaryKeyId: DEMO_NOTARY_KEY_ID, statement: heroStatement(), signature: "" },
    { notaryKeyId: DEMO_NOTARY_KEY_ID, statement: { ...heroStatement(), amount: "340" }, signature: "AA==" },
    Object.create(null),
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => verifyHero(input), `threw on ${JSON.stringify(input) ?? "undefined"}`);
    assert.equal(verifyHero(input).verified, false);
  }
});

test("an unsupported version is rejected", () => {
  const future = signAttestation(
    heroStatement({ version: 99 as never }),
    demoNotaryPrivateKey(),
    DEMO_NOTARY_KEY_ID,
  );
  const result = verifyHero(future);
  assert.ok(!result.verified && result.code === "version_mismatch");
});

test("verification is PURE — same inputs, same verdict, no hidden clock", () => {
  const a = verifyHero(goodAttestation());
  const b = verifyHero(goodAttestation());
  assert.deepEqual(a, b);
  // And the clock is injected, so the verdict moves only when `now` moves.
  assert.equal(verifyHero(goodAttestation(), heroExpectation(), NOW).verified, true);
  assert.equal(
    verifyHero(goodAttestation(), heroExpectation(), NOW + 3_600_000).verified,
    false,
  );
});

// ---------------------------------------------------------------------------
// Canonical encoding + domain separation.
// ---------------------------------------------------------------------------

test("canonicalJson is key-order independent (no signature malleability)", () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ x: { p: 1, q: 2 } }), canonicalJson({ x: { q: 2, p: 1 } }));
  // Arrays keep order — order is meaning in an array.
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("a statement verifies regardless of the key order it arrives in", () => {
  const good = goodAttestation();
  const s = good.statement;
  // Same statement, keys rebuilt in a different order (as a JSON round-trip
  // through another system might well produce).
  const reordered = {
    invoiceRef: s.invoiceRef,
    currency: s.currency,
    amount: s.amount,
    notarizedAt: s.notarizedAt,
    transcriptCommitment: s.transcriptCommitment,
    invoiceDigest: s.invoiceDigest,
    serverDomain: s.serverDomain,
    version: s.version,
  } as AttestedStatement;
  assert.equal(verifyHero({ ...good, statement: reordered }).verified, true);
});

test("signing bytes are domain-separated", () => {
  const bytes = signingBytes(heroStatement()).toString("utf8");
  assert.ok(bytes.startsWith(`${ATTESTATION_DOMAIN}\n`));
  // A signature over the bare statement (no domain tag) must not verify here —
  // otherwise a notary signature minted for another protocol, over bytes that
  // happen to parse as an attestation, could be replayed into this one.
  const bareSig = cryptoSign(
    null,
    Buffer.from(canonicalJson(heroStatement()), "utf8"),
    demoNotaryPrivateKey(),
  );
  const result = verifyHero({
    notaryKeyId: DEMO_NOTARY_KEY_ID,
    statement: heroStatement(),
    signature: bareSig.toString("base64"),
  });
  assert.ok(!result.verified && result.code === "bad_signature");
});

// ---------------------------------------------------------------------------
// Keyring: trust is a decision, not a computation.
// ---------------------------------------------------------------------------

test("an empty keyring verifies nothing (fail-closed)", () => {
  const result = verifyAttestation(goodAttestation(), {
    keyring: new Map(),
    expect: heroExpectation(),
    now: NOW,
  });
  assert.ok(!result.verified && result.code === "unknown_notary");
});

test("keyringFrom rejects a malformed PEM at construction, not at 3am", () => {
  assert.throws(() => keyringFrom({ bad_key: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----" }));
});

test("productionKeyring refuses to be empty or to trust the demo key", () => {
  assert.throws(() => productionKeyring({}), /no notary keys/);
  assert.throws(
    () => productionKeyring({ [DEMO_NOTARY_KEY_ID]: "whatever" }),
    /must never be trusted in production/,
  );
});

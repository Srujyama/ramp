/**
 * @ramp/attestation — agent identity tests
 *
 * A verifier is only worth what its rejections are worth. These use REAL
 * Ed25519 keys and REAL signatures — the point is that a caller who does not
 * hold an agent's private key cannot produce a signature that verifies for it,
 * so `requestingAgent` can no longer be impersonated once a key is issued.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  signAgentRequest,
  verifyAgentRequest,
  isAgentSignature,
  encodeAgentPublicKey,
  agentPublicKeyFromRegistry,
  demoAgentKeyId,
  demoAgentPrivateKey,
  demoAgentPublicKey,
  signAgentRequestDemo,
  AGENT_SIGNATURE_MAX_AGE_MS,
  type SignableRequest,
  type AgentRequestSignature,
} from "./agent-identity.js";

const REQ: SignableRequest = {
  requestingAgent: "agent_secure",
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
};

// A fixed clock so the tests are byte-reproducible (no fresh entropy / no now()).
const SIGNED_AT = "2026-07-18T12:00:00.000Z";
const NOW = Date.parse(SIGNED_AT) + 1000; // one second later — well within the window

function demoSig(req: SignableRequest = REQ, signedAt = SIGNED_AT): AgentRequestSignature {
  return signAgentRequestDemo(req, req.requestingAgent, signedAt);
}

test("a request signed by the agent's own key authenticates", () => {
  const sig = demoSig();
  const r = verifyAgentRequest(REQ, sig, {
    publicKey: demoAgentPublicKey("agent_secure"),
    now: NOW,
  });
  assert.equal(r.authenticated, true);
  assert.equal((r as { keyId: string }).keyId, demoAgentKeyId("agent_secure"));
});

test("verification survives a registry round-trip (encode -> DB string -> decode)", () => {
  const encoded = encodeAgentPublicKey(demoAgentPublicKey("agent_secure"));
  assert.equal(typeof encoded, "string");
  const r = verifyAgentRequest(REQ, demoSig(), {
    publicKey: agentPublicKeyFromRegistry(encoded),
    now: NOW,
  });
  assert.equal(r.authenticated, true);
});

test("tampering ANY bound field breaks the signature (bad_signature)", () => {
  const sig = demoSig();
  const key = demoAgentPublicKey("agent_secure");
  const mutations: Array<Partial<SignableRequest>> = [
    { amount: 341 },
    { amount: 9000 },
    { vendorId: "sketchy_llc" },
    { requestingAgent: "agent_47" },
    { category: "crypto" },
    { currency: "EUR" },
    { invoiceRef: "inv_other" },
  ];
  for (const m of mutations) {
    const r = verifyAgentRequest({ ...REQ, ...m }, sig, { publicKey: key, now: NOW });
    assert.equal(r.authenticated, false, `expected reject for mutation ${JSON.stringify(m)}`);
    assert.equal((r as { code: string }).code, "bad_signature");
  }
});

test("a signature made with a DIFFERENT key does not verify (no impersonation)", () => {
  // An attacker signs a request claiming to be agent_secure, using their OWN key.
  const attacker = generateKeyPairSync("ed25519");
  const forged = signAgentRequest(REQ, {
    privateKey: attacker.privateKey,
    keyId: demoAgentKeyId("agent_secure"), // lies about the key id
    signedAt: SIGNED_AT,
  });
  const r = verifyAgentRequest(REQ, forged, {
    publicKey: demoAgentPublicKey("agent_secure"), // the REAL registered key
    now: NOW,
  });
  assert.equal(r.authenticated, false);
  assert.equal((r as { code: string }).code, "bad_signature");
});

test("a missing or malformed signature is rejected, never thrown", () => {
  const key = demoAgentPublicKey("agent_secure");
  for (const bad of [undefined, null, {}, "sig", 42, { keyId: "x" }, { signature: 1 }]) {
    const r = verifyAgentRequest(REQ, bad, { publicKey: key, now: NOW });
    assert.equal(r.authenticated, false);
    assert.equal((r as { code: string }).code, "missing_signature");
  }
});

test("a stale signature is a replay and is rejected (expired)", () => {
  const sig = demoSig();
  const wayLater = Date.parse(SIGNED_AT) + AGENT_SIGNATURE_MAX_AGE_MS + 60_000;
  const r = verifyAgentRequest(REQ, sig, {
    publicKey: demoAgentPublicKey("agent_secure"),
    now: wayLater,
  });
  assert.equal(r.authenticated, false);
  assert.equal((r as { code: string }).code, "expired");
});

test("a future-dated signature is rejected (future_dated)", () => {
  const sig = demoSig(REQ, "2030-01-01T00:00:00.000Z");
  const r = verifyAgentRequest(REQ, sig, {
    publicKey: demoAgentPublicKey("agent_secure"),
    now: NOW,
  });
  assert.equal(r.authenticated, false);
  assert.equal((r as { code: string }).code, "future_dated");
});

test("a garbage timestamp is rejected (bad_timestamp), never thrown", () => {
  const sig = { ...demoSig(), signedAt: "not-a-date" };
  const r = verifyAgentRequest(REQ, sig, {
    publicKey: demoAgentPublicKey("agent_secure"),
    now: NOW,
  });
  assert.equal(r.authenticated, false);
  assert.equal((r as { code: string }).code, "bad_timestamp");
});

test("demo agent keys are distinct per agent id (independent, not one key in N hats)", () => {
  const a = encodeAgentPublicKey(demoAgentPublicKey("agent_secure"));
  const b = encodeAgentPublicKey(demoAgentPublicKey("agent_other"));
  assert.notEqual(a, b);
  // agent_other's key cannot authenticate a request naming agent_secure.
  const sig = demoSig();
  const r = verifyAgentRequest(REQ, sig, {
    publicKey: demoAgentPublicKey("agent_other"),
    now: NOW,
  });
  assert.equal(r.authenticated, false);
});

test("isAgentSignature guards the shape", () => {
  assert.equal(isAgentSignature(demoSig()), true);
  assert.equal(isAgentSignature({ keyId: "x", signedAt: "y" }), false);
  assert.equal(isAgentSignature(null), false);
});

test("the derived demo private key matches the demo public key (usable end to end)", () => {
  const sig = signAgentRequest(REQ, {
    privateKey: demoAgentPrivateKey("agent_secure"),
    keyId: demoAgentKeyId("agent_secure"),
    signedAt: SIGNED_AT,
  });
  const r = verifyAgentRequest(REQ, sig, {
    publicKey: demoAgentPublicKey("agent_secure"),
    now: NOW,
  });
  assert.equal(r.authenticated, true);
});

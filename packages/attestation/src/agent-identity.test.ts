/**
 * @ramp/attestation — agent-identity tests.
 *
 * The claims worth pinning: a genuine signature verifies against the registered
 * key and ONLY that key; tampering with any core field kills it; a missing /
 * malformed / wrong-scheme claim is a rejection, never a throw; and the demo
 * derivation is stable (the seeded registry PEMs depend on it byte-for-byte).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest } from "@ramp/shared";
import {
  agentIdentityCore,
  agentIdentitySigningBytes,
  demoAgentKeypair,
  signSpendRequest,
  verifyAgentIdentity,
} from "./agent-identity.js";

const AGENT = demoAgentKeypair("agent_47");
const OTHER = demoAgentKeypair("agent_12");

function baseRequest(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    vendorId: "acme_corp",
    amount: 340,
    currency: "USD",
    category: "office_supplies",
    invoiceRef: "inv_2026_07_0043",
    requestingAgent: "agent_47",
    ...overrides,
  };
}

test("a genuine signature verifies against the registered key", () => {
  const signed = signSpendRequest(baseRequest(), AGENT.privateKey);
  assert.equal(verifyAgentIdentity(signed, AGENT.publicKeyPem), true);
});

test("a signature by the WRONG key fails — the name is not the identity", () => {
  // The impersonation shape: correct agent id, somebody else's key. The
  // signature is mathematically valid — just not by agent_47's registered key.
  const signed = signSpendRequest(baseRequest(), OTHER.privateKey);
  assert.equal(verifyAgentIdentity(signed, AGENT.publicKeyPem), false);
});

test("no registered key (unknown or revoked agent) never verifies", () => {
  const signed = signSpendRequest(baseRequest(), AGENT.privateKey);
  assert.equal(verifyAgentIdentity(signed, null), false);
  assert.equal(verifyAgentIdentity(signed, undefined), false);
});

test("a missing identity claim is a rejection", () => {
  assert.equal(verifyAgentIdentity(baseRequest(), AGENT.publicKeyPem), false);
});

test("tampering with any core field after signing kills the signature", () => {
  const signed = signSpendRequest(baseRequest(), AGENT.privateKey);
  // The classic swap: sign a $340 request, present the signature on a $34000 one.
  assert.equal(
    verifyAgentIdentity({ ...signed, amount: 34000 }, AGENT.publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentity({ ...signed, vendorId: "sketchy_llc" }, AGENT.publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentity({ ...signed, category: "crypto" }, AGENT.publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentity({ ...signed, currency: "EUR" }, AGENT.publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentity({ ...signed, invoiceRef: "inv_other" }, AGENT.publicKeyPem),
    false,
  );
  // Rebinding the signature to a different agent id fails twice over: the core
  // changed AND the registry would serve a different key. Check the first half.
  assert.equal(
    verifyAgentIdentity({ ...signed, requestingAgent: "agent_12" }, AGENT.publicKeyPem),
    false,
  );
});

test("the excluded fields are genuinely excluded — the doc is judged elsewhere", () => {
  // invoiceDocument/attestation are quarantined/attestation-layer territory; the
  // identity core deliberately does not cover them, so attaching them after
  // signing does not disturb the identity verdict.
  const signed = signSpendRequest(baseRequest(), AGENT.privateKey);
  const withDoc: SpendRequest = {
    ...signed,
    invoiceDocument: "ACME CORP\nTotal: USD 340\n",
    attestation: { notaryKeyId: "x", statement: {}, signature: "AAAA" },
  };
  assert.equal(verifyAgentIdentity(withDoc, AGENT.publicKeyPem), true);
});

test("malformed claims are verdicts, never throws (total on the enforcement path)", () => {
  const req = baseRequest();
  const cases: SpendRequest[] = [
    { ...req, identity: { scheme: "ed25519", signature: "%%% not base64 %%%" } },
    { ...req, identity: { scheme: "ed25519", signature: "" } },
    // Wrong scheme — structurally present, semantically unsupported.
    { ...req, identity: { scheme: "rsa" as "ed25519", signature: "AAAA" } },
  ];
  for (const c of cases) {
    assert.equal(verifyAgentIdentity(c, AGENT.publicKeyPem), false);
  }
  // Garbage PEM: rejection, not a throw.
  const signed = signSpendRequest(req, AGENT.privateKey);
  assert.equal(verifyAgentIdentity(signed, "not a pem"), false);
});

test("an absent invoiceRef signs as the empty string — a statement, not an ambiguity", () => {
  const { invoiceRef: _omit, ...noRef } = baseRequest();
  const core = agentIdentityCore(noRef);
  assert.equal(core.invoiceRef, "");
  const signed = signSpendRequest(noRef, AGENT.privateKey);
  assert.equal(verifyAgentIdentity(signed, AGENT.publicKeyPem), true);
});

test("signing bytes are domain-separated", () => {
  const bytes = agentIdentitySigningBytes(baseRequest()).toString("utf8");
  assert.ok(bytes.startsWith("ramp.agent-identity.v1\n"));
});

test("the demo derivation is stable — the seeded registry depends on it", () => {
  // sql/seed.sql carries these PEMs verbatim. If this derivation moves, the
  // seeded registry keys stop matching the keys the demo signs with, and every
  // beat denies on deny/unauthenticated_agent. Fail HERE, with a message,
  // instead of there, mysteriously.
  assert.equal(
    demoAgentKeypair("agent_47").publicKeyPem.trim(),
    [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAUp/8GFZuf82NM0c0sROm8/562Geq3tJ3zWidjrnWugY=",
      "-----END PUBLIC KEY-----",
    ].join("\n"),
  );
  // Distinct agents derive distinct keys.
  assert.notEqual(AGENT.publicKeyPem, OTHER.publicKeyPem);
});

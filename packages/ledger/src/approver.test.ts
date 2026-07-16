/**
 * @ramp/ledger — approver.test.ts
 *
 * Identity is established from a signature, never claimed. These attack it
 * directly: forge, relabel, replay, tamper. Real Ed25519 throughout — a stubbed
 * signature proves nothing about a real check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  signApproval,
  checkApprover,
  approvalSigningBytes,
  demoApproverKeyring,
  demoApproverPrivateKey,
  APPROVAL_DOMAIN,
  type ApprovalStatement,
} from "./approver.js";

const KEYRING = demoApproverKeyring();

function statement(over: Partial<ApprovalStatement> = {}): ApprovalStatement {
  return {
    schema: "ramp/approval-v1",
    decisionId: "dec_1",
    verdict: "approved",
    factsDigest: "sha256:abc",
    note: null,
    at: "2026-07-16T12:00:00Z",
    ...over,
  };
}

test("a genuine approval establishes the signer's identity from the KEYRING", () => {
  const a = signApproval(statement(), demoApproverPrivateKey("approver_alice"), "approver_alice");
  const check = checkApprover(a, KEYRING);
  assert.equal(check.ok, true);
  assert.ok(check.ok && check.identity === "alice");
});

test("THE POINT: a valid signature by an UNREGISTERED key is rejected", () => {
  // Mathematically perfect, and rejected — the keyring is the trust decision.
  const attacker = generateKeyPairSync("ed25519");
  const forged = signApproval(statement(), attacker.privateKey, "approver_alice");
  const check = checkApprover(forged, KEYRING);
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.code === "bad_signature");
});

test("labelling your key with someone else's key id does not become them", () => {
  const attacker = generateKeyPairSync("ed25519");
  const forged = signApproval(statement(), attacker.privateKey, "approver_bob");
  const check = checkApprover(forged, KEYRING);
  assert.equal(check.ok, false, "you cannot borrow bob's identity by naming his key id");
});

test("an unknown key id is rejected before any crypto", () => {
  const outsider = generateKeyPairSync("ed25519");
  const a = signApproval(statement(), outsider.privateKey, "approver_mallory");
  const check = checkApprover(a, KEYRING);
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.code === "unknown_approver");
});

test("tampering with any signed field breaks the signature", () => {
  const real = signApproval(statement(), demoApproverPrivateKey("approver_alice"), "approver_alice");
  for (const patch of [
    { verdict: "rejected" as const },
    { decisionId: "dec_other" },
    { factsDigest: "sha256:different" },
    { note: "edited after signing" },
    { at: "2020-01-01T00:00:00Z" },
  ]) {
    const tampered = { ...real, statement: { ...real.statement, ...patch } };
    const check = checkApprover(tampered, KEYRING);
    assert.equal(check.ok, false, `tampering with ${Object.keys(patch)[0]} was not detected`);
  }
});

test("a signature is not transferable to a different statement", () => {
  const real = signApproval(statement(), demoApproverPrivateKey("approver_alice"), "approver_alice");
  const swapped = { ...real, statement: statement({ decisionId: "dec_2", factsDigest: "sha256:xyz" }) };
  assert.equal(checkApprover(swapped, KEYRING).ok, false);
});

test("signing bytes are domain-separated", () => {
  const bytes = approvalSigningBytes(statement()).toString("utf8");
  assert.ok(bytes.startsWith(`${APPROVAL_DOMAIN}\n`));
});

test("an empty keyring authenticates nobody (fail-closed)", () => {
  const a = signApproval(statement(), demoApproverPrivateKey("approver_alice"), "approver_alice");
  const check = checkApprover(a, new Map());
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.code === "unknown_approver");
});

test("checkApprover is TOTAL — hostile input is a verdict, never a throw", () => {
  for (const hostile of [
    undefined, null, "", 42, [], {},
    { statement: null, approverKeyId: "x", signature: "y" },
    { statement: statement(), approverKeyId: 1, signature: "y" },
    { statement: statement(), approverKeyId: "approver_alice", signature: "!!!not base64!!!" },
    Object.create(null),
  ]) {
    assert.doesNotThrow(() => checkApprover(hostile, KEYRING));
    assert.equal(checkApprover(hostile, KEYRING).ok, false);
  }
});

test("the demo approver keys are derived deterministically, not stored", () => {
  const a1 = demoApproverPrivateKey("approver_alice").export({ type: "pkcs8", format: "pem" });
  const a2 = demoApproverPrivateKey("approver_alice").export({ type: "pkcs8", format: "pem" });
  assert.deepEqual(a1, a2);
  // alice and bob are distinct.
  const b = demoApproverPrivateKey("approver_bob").export({ type: "pkcs8", format: "pem" });
  assert.notDeepEqual(a1, b);
});

test("HONEST LIMIT: whoever holds alice's key IS alice", () => {
  // Documented as an executable claim. In the demo, alice's key is public, so
  // anyone can be alice — by using it. That is what a key means; custody is a
  // deployment decision this module does not pretend to make.
  const asAlice = signApproval(statement(), demoApproverPrivateKey("approver_alice"), "approver_alice");
  const check = checkApprover(asAlice, KEYRING);
  assert.ok(check.ok && check.identity === "alice", "the published key genuinely signs as alice");
});

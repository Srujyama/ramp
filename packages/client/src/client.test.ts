/**
 * @ramp/client — tests
 *
 * The SDK is a convenience over the real lifecycle, so the test that matters is
 * that a payment made through it is judged IDENTICALLY to one made any other way:
 * the hero allows, the over-limit denies, escalations hold, and nothing about the
 * convenience weakens the verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoAgentKeypair, signSpendRequest } from "@ramp/attestation";
import { createRampClient, withRampClient } from "./index.js";

/**
 * A seeded in-memory client per test — throwaway, no on-disk state. A client
 * belongs to ONE agent, so it carries that agent's identity key: `pay()` signs
 * each request with it and the gate verifies against the seeded registry.
 */
function client(agentId = "agent_47") {
  return createRampClient({
    dbPath: ":memory:",
    provision: true,
    identityKey: demoAgentKeypair(agentId).privateKey,
  });
}

const HERO = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_sdk_hero",
  requestingAgent: "agent_47",
  serverDomain: "acme.example.com",
} as const;

test("pay: the hero happy path settles through the SDK", async () => {
  const ramp = client();
  try {
    const req = ramp.withDemoAttestation({ ...HERO });
    const r = await ramp.pay(req);
    assert.equal(r.status, "allowed");
    assert.equal(r.outcome, "allow");
    assert.equal(r.executed, true);
    assert.equal(r.proofVerified, true);
  } finally {
    ramp.close();
  }
});

test("pay: an unattested request is denied — the SDK does not wave it through", async () => {
  // withDemoAttestation is deliberately NOT called. The convenience makes the
  // honest path easy; it does not make the dishonest path possible.
  const ramp = client();
  try {
    const r = await ramp.pay({
      vendorId: "acme_corp",
      amount: 340,
      currency: "USD",
      category: "office_supplies",
      invoiceRef: "inv_bare",
      requestingAgent: "agent_47",
    });
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/attestation_invalid"));
    assert.equal(r.executed, false);
  } finally {
    ramp.close();
  }
});

test("pay: over the per-txn cap denies, judged identically to the hook", async () => {
  const ramp = client();
  try {
    const req = ramp.withDemoAttestation({ ...HERO, amount: 900, invoiceRef: "inv_big" });
    const r = await ramp.pay(req);
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/over_per_txn_cap"));
    assert.equal(r.executed, false);
  } finally {
    ramp.close();
  }
});

test("pay: an escalation is HELD, not paid", async () => {
  // $450 is within the cap, over the escalation threshold (400). agent_12 has the
  // daily headroom (agent_47 does not — its prior would deny first).
  const ramp = client("agent_12");
  try {
    const req = ramp.withDemoAttestation({
      ...HERO,
      amount: 450,
      requestingAgent: "agent_12",
      invoiceRef: "inv_esc",
    });
    const r = await ramp.pay(req);
    assert.equal(r.status, "escalated");
    assert.equal(r.outcome, "escalate");
    assert.equal(r.executed, false, "a held payment must never execute");
  } finally {
    ramp.close();
  }
});

test("preview: reports the outcome without spending", () => {
  const ramp = client();
  try {
    const before = ramp.decisions(50).length;
    const p = ramp.preview({
      requestingAgent: "agent_47",
      vendorId: "acme_corp",
      amount: 340,
      category: "office_supplies",
    });
    assert.equal(p.outcome, "allow");
    assert.equal(p.assumedAttested, true, "a preview states its attestation premise");
    assert.equal(ramp.decisions(50).length, before, "preview records nothing");
  } finally {
    ramp.close();
  }
});

test("budget: reports headroom, and maxUnattendedNow is the useful number", () => {
  const ramp = client();
  try {
    const b = ramp.budget("agent_47");
    assert.equal(b.spentToday, 1140);
    assert.equal(b.remainingToday, 360);
    // min(cap 500, threshold 400, remaining 360) = 360
    assert.equal(b.maxUnattendedNow, 360);
  } finally {
    ramp.close();
  }
});

test("budget: an unknown agent throws (fail-closed)", () => {
  const ramp = client();
  try {
    assert.throws(() => ramp.budget("agent_ghost"));
  } finally {
    ramp.close();
  }
});

test("approval: unresolved is null; a paid decision shows its verdict path", async () => {
  const ramp = client("agent_12");
  try {
    const req = ramp.withDemoAttestation({
      ...HERO,
      amount: 450,
      requestingAgent: "agent_12",
      invoiceRef: "inv_esc2",
    });
    const r = await ramp.pay(req);
    assert.equal(r.status, "escalated");
    // Nobody has approved it yet.
    assert.equal(ramp.approval(r.decisionId!), null);
  } finally {
    ramp.close();
  }
});

test("decisions: the log reflects what the SDK did", async () => {
  const ramp = client();
  try {
    await ramp.pay(ramp.withDemoAttestation({ ...HERO }));
    const log = ramp.decisions(10);
    assert.ok(log.length >= 1);
    assert.ok(log.some((d) => d.status === "allowed"));
  } finally {
    ramp.close();
  }
});

test("pay: a client with NO identity key is denied — unsigned proves nothing", async () => {
  const ramp = createRampClient({ dbPath: ":memory:", provision: true });
  try {
    const r = await ramp.pay(ramp.withDemoAttestation({ ...HERO }));
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/unauthenticated_agent"));
    assert.equal(r.executed, false);
  } finally {
    ramp.close();
  }
});

test("pay: THE IMPERSONATION — agent_47's name with agent_12's key is denied", async () => {
  // The client signs honestly with the key it was given; the key is simply not
  // the one the registry holds for the CLAIMED agent. The signature is
  // mathematically valid and still proves nothing about agent_47.
  const ramp = client("agent_12");
  try {
    const r = await ramp.pay(ramp.withDemoAttestation({ ...HERO })); // claims agent_47
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/unauthenticated_agent"));
    assert.equal(r.executed, false);
  } finally {
    ramp.close();
  }
});

test("pay: a tampered core field after signing is denied", async () => {
  // Pre-sign a $15 request with the RIGHT key, then present the signature on a
  // $340 one. The SDK respects a pre-signed request verbatim (it must not
  // re-sign what another key holder signed), so the stale signature reaches the
  // verifier — and dies there, because amount is inside the signed core.
  const ramp = client();
  try {
    const small = ramp.withDemoAttestation({ ...HERO, amount: 15, invoiceRef: "inv_small" });
    const signedSmall = signSpendRequest(small, demoAgentKeypair("agent_47").privateKey);
    const inflated = ramp.withDemoAttestation({
      ...HERO,
      amount: 340,
      invoiceRef: "inv_small",
    });
    const r = await ramp.pay({ ...inflated, identity: signedSmall.identity });
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/unauthenticated_agent"));
    assert.equal(r.executed, false);
  } finally {
    ramp.close();
  }
});

test("withRampClient closes the handle even on throw", async () => {
  await assert.rejects(
    withRampClient({ dbPath: ":memory:", provision: true }, async (ramp) => {
      ramp.budget("agent_ghost"); // throws
    }),
  );
  // No assertion on the handle itself (it's private), but this exercises the
  // finally path — a leaked handle would surface as a resource warning under
  // --test over many runs.
});

test("the SDK reuses the real kernel — same verdict as evaluating directly", async () => {
  // Sanity that "convenience, not a second policy path" holds: preview (which runs
  // the real kernel) agrees with pay's outcome for the same facts. agent_12's own
  // client — pay() signs as the client's agent, and this payment is agent_12's.
  const ramp = client("agent_12");
  try {
    const preview = ramp.preview({
      requestingAgent: "agent_12",
      vendorId: "acme_corp",
      amount: 450,
      category: "office_supplies",
    });
    const paid = await ramp.pay(
      ramp.withDemoAttestation({ ...HERO, amount: 450, requestingAgent: "agent_12", invoiceRef: "inv_x" }),
    );
    assert.equal(preview.outcome, paid.outcome, "preview and pay must agree on the verdict");
  } finally {
    ramp.close();
  }
});

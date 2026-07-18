/**
 * @ramp/payments-mcp — enforcing tool tests (node:test)
 *
 * Two layers:
 *
 *  1. REAL lifecycle: `handlePayVendor` against a freshly seeded IN-MEMORY ledger
 *     (`openLedger(":memory:")`) so allow/deny come from the real policy kernel and
 *     the real `requestPurchase` (policy -> provenance -> proof -> persist -> verify
 *     -> execute). Fixtures are drawn from the demo seed (agent_47 / acme_corp /
 *     office_supplies, per-txn cap 500, daily limit 1500, prior spend 1140).
 *
 *  2. MAPPING: `requestPurchase` is stubbed via injected deps so every result
 *     status maps to the exact, stable structuredContent schema — including the
 *     four failure classes and the guarantee that NO secrets ever leak into a
 *     response, independent of Agent B (purchase) / Agent D (executor).
 *
 * Runs against the built output (dist) so `node --test` picks them up after `tsc`.
 *
 * NOTE for the coordinator: the live end-to-end MCP stdio transport allow+deny is
 * intentionally left to the integrated run (deps for @ramp/ledger + @ramp/gate are
 * wired by the coordinator). These tests exercise the real handler + real kernel
 * against a seeded in-memory ledger, which is the same enforcement path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { openLedger, closeLedger, getDecision } from "@ramp/ledger";
import {
  signAttestation,
  digestInvoice,
  demoNotaryPrivateKey,
  DEMO_NOTARY_KEY_ID,
  ATTESTATION_VERSION,
  signSpendRequest,
  demoAgentKeypair,
} from "@ramp/attestation";
import type { SpendRequest } from "@ramp/shared";
import {
  handlePayVendor,
  createServer,
  payVendorInputSchema,
  type PayVendorDeps,
} from "../dist/server.js";

// ---------------------------------------------------------------------------
// Fixtures drawn straight from sql/seed.sql (the demo scenario).
// ---------------------------------------------------------------------------

/**
 * The invoice Acme's server serves for the hero request. Untrusted prose — the
 * tool only ever hashes it, to check the attestation binds to THESE bytes.
 */
const HERO_INVOICE =
  "ACME CORP\nInvoice inv_2026_07_0043\nOffice supplies\nTotal: USD 340\n";

/**
 * Mint a genuine attestation for the hero invoice.
 *
 * A REAL Ed25519 signature from the demo notary — nothing stubbed. Since pillar 4
 * landed, `deny/attestation_invalid` (policy.dl D6) denies any payment without a
 * VERIFIED attestation, so an allow-path fixture must carry one. Notarised at
 * call time so it is always inside the freshness window.
 */
function heroAttestation() {
  return signAttestation(
    {
      version: ATTESTATION_VERSION,
      serverDomain: "acme.example.com", // == vendors.registry_domain in seed.sql
      invoiceDigest: digestInvoice(HERO_INVOICE),
      transcriptCommitment: "tc_test_0001",
      notarizedAt: new Date().toISOString(),
      amount: 340,
      currency: "USD",
      invoiceRef: "inv_2026_07_0043",
    },
    demoNotaryPrivateKey(),
    DEMO_NOTARY_KEY_ID,
  );
}

/** Hero happy path: 1140 + 340 = 1480 <= 1500, 340 <= cap 500, verified+approved+cleared+attested. */
const ALLOW_ARGS = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
  invoiceDocument: HERO_INVOICE,
  get attestation() {
    // A getter, so every use gets a FRESHLY notarised attestation. A module-level
    // constant would age past the 15-minute freshness window in a long run and
    // fail as `expired` — a maddening flake that looks like a policy bug.
    return heroAttestation();
  },
} as const;

/**
 * Deny: unverified vendor (small amount, so the cap/daily rules stay quiet).
 *
 * No attestation, deliberately: an unverified vendor has no registered domain,
 * so no attestation could verify for it anyway. Both vendor_not_verified and
 * attestation_invalid fire — see the test for why that pair is inseparable.
 */
const DENY_ARGS = {
  vendorId: "sketchy_llc",
  amount: 40,
  currency: "USD",
  category: "office_supplies",
  requestingAgent: "agent_47",
} as const;

/** A fresh, fully-seeded in-memory ledger per handler call. */
const seededDeps: PayVendorDeps = { openDb: () => openLedger(":memory:") };

/**
 * Sign tool args as the requesting agent (default) or an impersonator. Applied
 * AFTER any per-test field overrides, because the signature covers the identity
 * core — sign-then-override would be the tamper case, which has its own test.
 */
function signedArgs<T extends { requestingAgent: string }>(
  args: T,
  signingAgent = args.requestingAgent,
): T & { identity: { scheme: "ed25519"; signature: string } } {
  const { identity } = signSpendRequest(
    args as unknown as SpendRequest,
    demoAgentKeypair(signingAgent).privateKey,
  );
  return { ...args, identity: identity! };
}

// Exact, frozen key sets for the three structuredContent schemas.
const ALLOW_KEYS = [
  "amount",
  "currency",
  "decisionId",
  "executionId",
  "firedRules",
  "message",
  "paymentStatus",
  "policyOutcome",
  "proofId",
  "proofVerified",
  "settlementId",
  "requestId",
  "status",
  "vendor",
].sort();

const DENY_KEYS = [
  "decisionId",
  "firedRules",
  "message",
  "policyOutcome",
  "proofId",
  "proofVerified",
  "reason",
  "status",
].sort();

const ERROR_KEYS = ["decisionId", "message", "status"].sort();

const keys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();

// ===========================================================================
// 1. REAL lifecycle against a seeded in-memory ledger.
// ===========================================================================

test("ALLOW: seeded happy path settles a sandbox payment with a verified proof", async () => {
  const res = await handlePayVendor(signedArgs({ ...ALLOW_ARGS }), seededDeps);
  const sc = res.structuredContent;

  assert.equal(res.isError, undefined);
  assert.equal(sc.status, "allowed");
  assert.equal(sc.policyOutcome, "allow");
  assert.equal(sc.vendor, "acme_corp");
  assert.equal(sc.amount, 340);
  assert.equal(sc.currency, "USD");
  assert.equal(sc.paymentStatus, "settled");
  assert.equal(sc.proofVerified, true);
  assert.ok(typeof sc.decisionId === "string" && sc.decisionId.length > 0);
  assert.ok(typeof sc.settlementId === "string" && (sc.settlementId as string).length > 0);
  assert.ok(typeof sc.executionId === "string" && (sc.executionId as string).length > 0);
  assert.deepEqual(sc.firedRules, ["allow/all_conditions_met"]);
  // Stable schema: exactly the ALLOW key set.
  assert.deepEqual(keys(sc), ALLOW_KEYS);
});

test("DENY: unverified vendor is denied, no settlement and no payment", async () => {
  const res = await handlePayVendor(signedArgs({ ...DENY_ARGS }), seededDeps);
  const sc = res.structuredContent;

  // A clean policy deny is NOT a tool error.
  assert.equal(res.isError, undefined);
  assert.equal(sc.status, "denied");
  assert.equal(sc.policyOutcome, "deny");
  // BOTH rules fire, and they always will for an unverified vendor — this pair is
  // correlated by design, not an accident of the fixture. An attestation binds
  // invoice bytes to the vendor's REGISTERED domain; an unverified vendor has no
  // registered domain to bind to, so no attestation can possibly verify for one.
  // "Unverified vendor" therefore implies "unattestable" — there is no such thing
  // as a properly attested payment to a vendor we never registered.
  assert.deepEqual(sc.firedRules, [
    "deny/vendor_not_verified",
    "deny/attestation_invalid",
  ]);
  assert.match(String(sc.reason), /vendor_not_verified/);
  // No execution surface leaked on a deny.
  assert.equal("settlementId" in sc, false);
  assert.equal("executionId" in sc, false);
  assert.equal("paymentStatus" in sc, false);
  assert.deepEqual(keys(sc), DENY_KEYS);
});

test("DENY: over daily-limit amount (361) trips daily_limit_exceeded", async () => {
  // 1140 + 361 = 1501 > 1500, still <= per-txn cap 500.
  const res = await handlePayVendor(signedArgs({ ...ALLOW_ARGS, amount: 361 }), seededDeps);
  const sc = res.structuredContent;
  assert.equal(sc.status, "denied");
  assert.ok((sc.firedRules as string[]).includes("deny/daily_limit_exceeded"));
});

test("IDEMPOTENT: identical requests yield the same decisionId", async () => {
  // Ed25519 is deterministic, so signing the same core twice yields the same
  // signature bytes — and therefore the same content-addressed decisionId.
  const a = await handlePayVendor(signedArgs({ ...ALLOW_ARGS }), seededDeps);
  const b = await handlePayVendor(signedArgs({ ...ALLOW_ARGS }), seededDeps);
  assert.equal(a.structuredContent.status, "allowed");
  assert.equal(b.structuredContent.status, "allowed");
  assert.equal(a.structuredContent.decisionId, b.structuredContent.decisionId);
  // The proof/settlement record are deterministic too.
  assert.equal(a.structuredContent.proofId, b.structuredContent.proofId);
  assert.equal(a.structuredContent.settlementId, b.structuredContent.settlementId);
});

test("DENY: an UNSIGNED request is refused — deny/unauthenticated_agent", async () => {
  // The exact args that allow above, minus the identity claim. The second gate
  // verifies identity itself (no hook present), so anonymity dies here too.
  const res = await handlePayVendor({ ...ALLOW_ARGS }, seededDeps);
  const sc = res.structuredContent;
  assert.equal(sc.status, "denied");
  assert.deepEqual(sc.firedRules, ["deny/unauthenticated_agent"]);
});

test("DENY: THE IMPERSONATION — agent_47's name signed with agent_12's key", async () => {
  // A mathematically valid signature by the WRONG registered key. The registry
  // holds agent_47's key; agent_12's signature over agent_47's request proves
  // nothing about agent_47, and the kernel denies.
  const res = await handlePayVendor(
    signedArgs({ ...ALLOW_ARGS }, "agent_12"),
    seededDeps,
  );
  const sc = res.structuredContent;
  assert.equal(sc.status, "denied");
  assert.deepEqual(sc.firedRules, ["deny/unauthenticated_agent"]);
  assert.equal("settlementId" in sc, false, "an impersonator gets no execution surface");
});

test("DENY: a core field changed after signing is refused (tamper)", async () => {
  // Sign a $15 request honestly, then present that signature on the $340 one.
  // `amount` is inside the signed identity core, so the stale signature dies.
  const small = signedArgs({ ...ALLOW_ARGS, amount: 15 });
  const res = await handlePayVendor({ ...ALLOW_ARGS, identity: small.identity }, seededDeps);
  const sc = res.structuredContent;
  assert.equal(sc.status, "denied");
  assert.deepEqual(sc.firedRules, ["deny/unauthenticated_agent"]);
});

test("DENY: an UNREGISTERED agent cannot authenticate, whatever it signs with", async () => {
  // agent_ghost has no registry row at all. Note the deny arrives as a
  // policy_error here rather than a kernel deny — the fact source refuses to
  // synthesise facts for an unknown identity (UnknownAgentError) before the
  // kernel ever runs, and the lifecycle fails CLOSED with no execution.
  const res = await handlePayVendor(
    signedArgs({ ...DENY_ARGS, requestingAgent: "agent_ghost" }),
    seededDeps,
  );
  const sc = res.structuredContent;
  assert.notEqual(sc.status, "allowed");
  assert.equal("settlementId" in sc, false);
});

// ===========================================================================
// 2. Input validation at the zod boundary (the SDK applies this pre-handler).
//    isSpendRequest does NOT enforce int/nonnegative — this schema does.
// ===========================================================================

test("input: a valid tool_input parses", () => {
  assert.equal(payVendorInputSchema.safeParse({ ...ALLOW_ARGS }).success, true);
  assert.equal(payVendorInputSchema.safeParse(signedArgs({ ...ALLOW_ARGS })).success, true);
});

test("input: a malformed identity claim is rejected at the zod boundary", () => {
  const bad = { ...ALLOW_ARGS, identity: { scheme: "rsa", signature: "AAAA" } };
  assert.equal(payVendorInputSchema.safeParse(bad).success, false);
  const noSig = { ...ALLOW_ARGS, identity: { scheme: "ed25519" } };
  assert.equal(payVendorInputSchema.safeParse(noSig).success, false);
});

test("input: non-integer amount is rejected", () => {
  const r = payVendorInputSchema.safeParse({ ...ALLOW_ARGS, amount: 340.5 });
  assert.equal(r.success, false);
});

test("input: negative amount is rejected", () => {
  const r = payVendorInputSchema.safeParse({ ...ALLOW_ARGS, amount: -5 });
  assert.equal(r.success, false);
});

test("input: missing vendorId is rejected", () => {
  const { vendorId: _drop, ...noVendor } = ALLOW_ARGS;
  const r = payVendorInputSchema.safeParse(noVendor);
  assert.equal(r.success, false);
});

test("defense-in-depth: a malformed request never opens the ledger", async () => {
  // Bypass zod (simulate a compromised SDK) with a non-SpendRequest; the handler's
  // isSpendRequest re-guard must reject BEFORE touching the DB.
  const guardDeps: PayVendorDeps = {
    openDb: () => {
      throw new Error("openDb must not be called for invalid input");
    },
  };
  const res = await handlePayVendor(
    { ...ALLOW_ARGS, vendorId: undefined as unknown as string },
    guardDeps,
  );
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.status, "policy_error");
  assert.equal(res.structuredContent.decisionId, null);
  assert.deepEqual(keys(res.structuredContent), ERROR_KEYS);
});

// ===========================================================================
// 3. Status -> structuredContent mapping, driven by a stubbed requestPurchase.
//    (Hermetic: no real ledger/kernel/executor needed.)
// ===========================================================================

/** Deps whose ledger/kernel/executor are inert; only runPurchase drives output. */
function stubDeps(
  runPurchase: PayVendorDeps["runPurchase"],
  capture?: (input: unknown) => void,
): PayVendorDeps {
  return {
    openDb: () => ({}) as never,
    getKernel: () => ({ kind: "ts-reference", kernel: {} as never }),
    makeExecutor: () => ({}) as never,
    runPurchase: async (input) => {
      capture?.(input);
      return runPurchase!(input);
    },
  };
}

const ALLOWED_RESULT = {
  status: "allowed",
  decisionId: "dec_stub",
  outcome: "allow",
  firedRules: ["allow/all_conditions_met"],
  reasons: ["all_conditions_met: ok"],
  proofId: "proof_stub",
  proofVerified: true,
  settlement: {
    settlementId: "rcpt_stub",
    executionId: "exec_stub",
    status: "settled",
    provider: "sandbox",
  },
  executed: true,
  message: "Payment settled: 340 USD to acme_corp (rcpt_stub)",
  requestId: "inv_2026_07_0043",
} as const;

test("mapping: allowed result copies only whitelisted, labeled fields", async () => {
  const res = await handlePayVendor(
    { ...ALLOW_ARGS },
    stubDeps(async () => ALLOWED_RESULT as never),
  );
  assert.equal(res.isError, undefined);
  assert.deepEqual(keys(res.structuredContent), ALLOW_KEYS);
  assert.equal(res.structuredContent.executionId, "exec_stub");
  assert.equal(res.structuredContent.paymentStatus, "settled");
});

test("mapping: denied result carries reasons but no execution surface", async () => {
  const denied = {
    status: "denied",
    decisionId: "dec_deny",
    outcome: "deny",
    firedRules: ["deny/vendor_not_verified", "deny/daily_limit_exceeded"],
    reasons: ["vendor_not_verified: ...", "daily_limit_exceeded: ..."],
    proofId: "proof_deny",
    proofVerified: true,
    settlement: null,
    executed: false,
    message: "Denied by policy",
    requestId: "dec_deny",
  };
  const res = await handlePayVendor(
    { ...DENY_ARGS },
    stubDeps(async () => denied as never),
  );
  assert.equal(res.isError, undefined);
  assert.deepEqual(keys(res.structuredContent), DENY_KEYS);
  assert.equal(
    res.structuredContent.reason,
    "vendor_not_verified: ...; daily_limit_exceeded: ...",
  );
});

for (const status of ["policy_error", "audit_error", "executor_error"] as const) {
  test(`mapping: ${status} maps to an isError tool result`, async () => {
    const errResult = {
      status,
      decisionId: status === "policy_error" ? null : "dec_err",
      outcome: null,
      firedRules: [],
      reasons: [],
      proofId: null,
      proofVerified: false,
      settlement: null,
      executed: false,
      message: `${status} occurred`,
      requestId: "req_err",
    };
    const res = await handlePayVendor(
      { ...ALLOW_ARGS },
      stubDeps(async () => errResult as never),
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.status, status);
    assert.deepEqual(keys(res.structuredContent), ERROR_KEYS);
  });
}

test("secrets: never surfaced even if the settlement carries credential-shaped fields", async () => {
  const leaky = {
    ...ALLOWED_RESULT,
    settlement: {
      settlementId: "rcpt_ok",
      executionId: "exec_ok",
      status: "settled",
      provider: "sandbox",
      // Contract forbids these; assert the handler WHITELIST drops them anyway.
      apiKey: "sk_live_LEAK",
      cardNumber: "4242424242424242",
      secret: "topsecret",
      credential: "cred_abc",
    },
  };
  const res = await handlePayVendor(
    { ...ALLOW_ARGS },
    stubDeps(async () => leaky as never),
  );
  const serialized = JSON.stringify(res);
  for (const needle of ["sk_live_LEAK", "4242424242424242", "topsecret", "cred_abc"]) {
    assert.equal(serialized.includes(needle), false, `leaked: ${needle}`);
  }
  for (const forbiddenKey of [/apiKey/i, /cardNumber/i, /"secret"/i, /credential/i]) {
    assert.equal(forbiddenKey.test(serialized), false, `leaked key: ${forbiddenKey}`);
  }
  // Still returns the non-sensitive settlement record handles.
  assert.equal(res.structuredContent.settlementId, "rcpt_ok");
  assert.equal(res.structuredContent.executionId, "exec_ok");
});

test("reason is UX-only: not fed into the request/facts; ids are forwarded", async () => {
  let captured: any;
  await handlePayVendor(
    {
      ...ALLOW_ARGS,
      reason: "buying printer paper",
      toolCallId: "tc_1",
      taskId: "task_9",
    },
    stubDeps(
      async () => ALLOWED_RESULT as never,
      (input) => {
        captured = input;
      },
    ),
  );
  // reason must NOT reach the SpendRequest (it is not a policy fact).
  assert.equal("reason" in captured.request, false);
  // toolCallId / taskId are forwarded to the provenance-bearing lifecycle.
  assert.equal(captured.toolCallId, "tc_1");
  assert.equal(captured.taskId, "task_9");
});

// ===========================================================================
// 4. Server assembly smoke.
// ===========================================================================

test("createServer() builds a server with the pay_vendor tool registered", () => {
  const server = createServer();
  assert.ok(server, "server constructed");
});

// ---------------------------------------------------------------------------
// RAMP_FAIL_VENDORS seam: a live server can deterministically drive the
// executor_error path (allowed + persisted + verified, then payment fails)
// through the REAL lifecycle with no stub, no real provider, and no secret.
// ---------------------------------------------------------------------------
test("RAMP_FAIL_VENDORS makes an allowed sandbox payment fail (executor_error)", async () => {
  const prev = process.env.RAMP_FAIL_VENDORS;
  process.env.RAMP_FAIL_VENDORS = "acme_corp";
  try {
    const res = await handlePayVendor(signedArgs({ ...ALLOW_ARGS }), seededDeps);
    const sc = res.structuredContent;
    // Policy still ALLOWED (the seam only affects the executor, never policy)...
    assert.equal(res.isError, true);
    assert.equal(sc.status, "executor_error");
    // ...and it is NEVER represented as a settled payment.
    assert.notEqual(sc.status, "allowed");
    assert.equal(sc.paymentStatus, undefined);
    assert.equal(sc.settlementId, undefined);
    // No secret/stack trace leaks in the failure envelope.
    const text = JSON.stringify(sc);
    assert.doesNotMatch(text, /key|secret|token|credential|password|\bat \//i);
  } finally {
    if (prev === undefined) delete process.env.RAMP_FAIL_VENDORS;
    else process.env.RAMP_FAIL_VENDORS = prev;
  }
});

test("RAMP_FAIL_VENDORS unset: the sandbox settles normally", async () => {
  const prev = process.env.RAMP_FAIL_VENDORS;
  delete process.env.RAMP_FAIL_VENDORS;
  try {
    const res = await handlePayVendor(signedArgs({ ...ALLOW_ARGS }), seededDeps);
    assert.equal(res.structuredContent.status, "allowed");
  } finally {
    if (prev !== undefined) process.env.RAMP_FAIL_VENDORS = prev;
  }
});

// ---------------------------------------------------------------------------
// RAMP_DB_PATH honoring: the DEFAULT openDb (no injected deps) must open the
// ledger the client docs promise, so the server + bridge + CLI share one file.
// ---------------------------------------------------------------------------
test("default openDb honors RAMP_DB_PATH (server + bridge share one ledger)", async () => {
  const dbPath = join(tmpdir(), `ramp-mcp-${randomUUID()}.db`);
  const prev = process.env.RAMP_DB_PATH;
  process.env.RAMP_DB_PATH = dbPath;
  try {
    // No deps override → exercises DEFAULT_DEPS.openDb.
    const res = await handlePayVendor(signedArgs({ ...ALLOW_ARGS }));
    assert.equal(res.structuredContent.status, "allowed");
    const decisionId = res.structuredContent.decisionId as string;

    // Re-open the SAME path independently: the decision + execution must be there.
    const db = openLedger(dbPath);
    try {
      const rec = getDecision(db, decisionId);
      assert.ok(rec, "decision persisted to RAMP_DB_PATH");
      assert.equal(rec.execution?.status, "settled");
    } finally {
      closeLedger(db);
    }
  } finally {
    if (prev === undefined) delete process.env.RAMP_DB_PATH;
    else process.env.RAMP_DB_PATH = prev;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });
  }
});

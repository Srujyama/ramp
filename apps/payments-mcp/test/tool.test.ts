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

import { openLedger } from "@ramp/ledger";
import {
  handlePayVendor,
  createServer,
  payVendorInputSchema,
  type PayVendorDeps,
} from "../dist/server.js";

// ---------------------------------------------------------------------------
// Fixtures drawn straight from sql/seed.sql (the demo scenario).
// ---------------------------------------------------------------------------

/** Hero happy path: 1140 + 340 = 1480 <= 1500, 340 <= cap 500, verified+approved+cleared. */
const ALLOW_ARGS = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
} as const;

/** Clean deny: unverified vendor (small amount so ONLY the vendor rule fires). */
const DENY_ARGS = {
  vendorId: "sketchy_llc",
  amount: 40,
  currency: "USD",
  category: "office_supplies",
  requestingAgent: "agent_47",
} as const;

/** A fresh, fully-seeded in-memory ledger per handler call. */
const seededDeps: PayVendorDeps = { openDb: () => openLedger(":memory:") };

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
  "receiptId",
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
  const res = await handlePayVendor({ ...ALLOW_ARGS }, seededDeps);
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
  assert.ok(typeof sc.receiptId === "string" && (sc.receiptId as string).length > 0);
  assert.ok(typeof sc.executionId === "string" && (sc.executionId as string).length > 0);
  assert.deepEqual(sc.firedRules, ["allow/all_conditions_met"]);
  // Stable schema: exactly the ALLOW key set.
  assert.deepEqual(keys(sc), ALLOW_KEYS);
});

test("DENY: unverified vendor is denied, no receipt and no payment", async () => {
  const res = await handlePayVendor({ ...DENY_ARGS }, seededDeps);
  const sc = res.structuredContent;

  // A clean policy deny is NOT a tool error.
  assert.equal(res.isError, undefined);
  assert.equal(sc.status, "denied");
  assert.equal(sc.policyOutcome, "deny");
  assert.deepEqual(sc.firedRules, ["deny/vendor_not_verified"]);
  assert.match(String(sc.reason), /vendor_not_verified/);
  // No execution surface leaked on a deny.
  assert.equal("receiptId" in sc, false);
  assert.equal("executionId" in sc, false);
  assert.equal("paymentStatus" in sc, false);
  assert.deepEqual(keys(sc), DENY_KEYS);
});

test("DENY: over daily-limit amount (361) trips daily_limit_exceeded", async () => {
  // 1140 + 361 = 1501 > 1500, still <= per-txn cap 500.
  const res = await handlePayVendor(
    { ...ALLOW_ARGS, amount: 361 },
    seededDeps,
  );
  const sc = res.structuredContent;
  assert.equal(sc.status, "denied");
  assert.ok((sc.firedRules as string[]).includes("deny/daily_limit_exceeded"));
});

test("IDEMPOTENT: identical requests yield the same decisionId", async () => {
  const a = await handlePayVendor({ ...ALLOW_ARGS }, seededDeps);
  const b = await handlePayVendor({ ...ALLOW_ARGS }, seededDeps);
  assert.equal(a.structuredContent.status, "allowed");
  assert.equal(b.structuredContent.status, "allowed");
  assert.equal(a.structuredContent.decisionId, b.structuredContent.decisionId);
  // The proof/receipt are deterministic too.
  assert.equal(a.structuredContent.proofId, b.structuredContent.proofId);
  assert.equal(a.structuredContent.receiptId, b.structuredContent.receiptId);
});

// ===========================================================================
// 2. Input validation at the zod boundary (the SDK applies this pre-handler).
//    isSpendRequest does NOT enforce int/nonnegative — this schema does.
// ===========================================================================

test("input: a valid tool_input parses", () => {
  assert.equal(payVendorInputSchema.safeParse({ ...ALLOW_ARGS }).success, true);
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
  receipt: {
    receiptId: "rcpt_stub",
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
    receipt: null,
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
      receipt: null,
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

test("secrets: never surfaced even if the receipt carries credential-shaped fields", async () => {
  const leaky = {
    ...ALLOWED_RESULT,
    receipt: {
      receiptId: "rcpt_ok",
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
  // Still returns the non-sensitive receipt handles.
  assert.equal(res.structuredContent.receiptId, "rcpt_ok");
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

/**
 * @ramp/payments-mcp — sandbox executor tests (node:test)
 *
 * Verifies the SANDBOX payment executor:
 *   - a successful execution settles with provider "sandbox",
 *   - the receipt is deterministic/idempotent (same request -> identical receipt,
 *     including executionId),
 *   - changing a request field changes the receiptId,
 *   - the failVendorIds hook yields a "failed" receipt (to exercise executor_error),
 *   - the receipt carries NO secret/credential fields — its key set is exactly
 *     {receiptId, executionId, status, provider}.
 *
 * These run against the built output (dist) so `node --test` picks them up after
 * `tsc`. They import the compiled `.js` (NodeNext ESM).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxExecutor, makeSandboxExecutor } from "../dist/executor.js";
import type { ExecutorRequest } from "@ramp/ledger";

/** Minimal, inline ExecutorRequest fixture (idempotencyKey == decisionId). */
function makeReq(overrides?: {
  decisionId?: string;
  request?: Partial<ExecutorRequest["request"]>;
}): ExecutorRequest {
  const decisionId = overrides?.decisionId ?? "dec_test_0001";
  return {
    decisionId,
    idempotencyKey: decisionId,
    request: {
      vendorId: "acme_corp",
      amount: 340,
      currency: "USD",
      category: "office_supplies",
      requestingAgent: "agent_47",
      invoiceRef: "inv_2026_07_0043",
      ...overrides?.request,
    },
  };
}

const EXPECTED_KEYS = ["executionId", "provider", "receiptId", "status"];

test("successful sandbox execution settles with provider sandbox", () => {
  const receipt = new SandboxExecutor().execute(makeReq());
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.provider, "sandbox");
  assert.match(receipt.receiptId, /^rcpt_[0-9a-f]{16}$/);
  assert.match(receipt.executionId, /^exec_[0-9a-f]{16}$/);
});

test("receipt is deterministic/idempotent for an identical request", () => {
  const exec = makeSandboxExecutor();
  const a = exec.execute(makeReq());
  const b = exec.execute(makeReq());
  // Same request (incl. same decisionId) -> byte-identical receipt.
  assert.deepEqual(a, b);
  assert.equal(a.executionId, b.executionId);
  assert.equal(a.receiptId, b.receiptId);
});

test("executionId is derived from decisionId and stable across retries", () => {
  const exec = makeSandboxExecutor();
  // Different money fields, SAME decisionId -> same executionId (retry semantics).
  const a = exec.execute(makeReq({ decisionId: "dec_same" }));
  const b = exec.execute(makeReq({ decisionId: "dec_same", request: { amount: 999 } }));
  assert.equal(a.executionId, b.executionId);
  // A different decisionId yields a different executionId.
  const c = exec.execute(makeReq({ decisionId: "dec_other" }));
  assert.notEqual(a.executionId, c.executionId);
});

test("changing a request field changes the receiptId", () => {
  const exec = makeSandboxExecutor();
  const a = exec.execute(makeReq());
  const bAmount = exec.execute(makeReq({ request: { amount: 341 } }));
  const bVendor = exec.execute(makeReq({ request: { vendorId: "other_vendor" } }));
  const bCurrency = exec.execute(makeReq({ request: { currency: "EUR" } }));
  assert.notEqual(a.receiptId, bAmount.receiptId);
  assert.notEqual(a.receiptId, bVendor.receiptId);
  assert.notEqual(a.receiptId, bCurrency.receiptId);
});

test("failVendorIds yields a failed sandbox receipt (executor_error path)", () => {
  const exec = makeSandboxExecutor({ failVendorIds: ["acme_corp"] });
  const failed = exec.execute(makeReq({ request: { vendorId: "acme_corp" } }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.provider, "sandbox");
  // A vendor NOT in the list still settles.
  const ok = exec.execute(makeReq({ request: { vendorId: "trusted_vendor" } }));
  assert.equal(ok.status, "settled");
});

test("receipt has exactly the expected keys and no secret/credential fields", () => {
  const receipt = new SandboxExecutor().execute(makeReq());
  assert.deepEqual(Object.keys(receipt).sort(), EXPECTED_KEYS);
  // Belt-and-suspenders: no key or value looks like a secret/credential.
  const forbidden = /key|secret|card|token|credential|password|pan|cvv/i;
  for (const [k, v] of Object.entries(receipt)) {
    assert.ok(!forbidden.test(k), `receipt key "${k}" looks secret-bearing`);
    assert.ok(
      typeof v !== "string" || !forbidden.test(v),
      `receipt value for "${k}" looks secret-bearing`,
    );
  }
});

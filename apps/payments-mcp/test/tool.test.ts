/**
 * @ramp/payments-mcp — tool tests (node:test)
 *
 * Verifies the stub behaves honestly:
 *   - a valid tool_input maps to a valid SpendRequest,
 *   - makeFakeReceipt produces a deterministic receipt with status "submitted",
 *   - the receipt id is stable across identical requests and varies with inputs.
 *
 * These run against the built output (dist) so `node --test` picks them up after
 * `tsc`. They import the compiled `.js` (NodeNext ESM).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSpendRequest, type SpendRequest } from "@ramp/shared";
import { makeFakeReceipt, newRequestId } from "../dist/receipt.js";

/** Fixed request id so makeFakeReceipt stays a pure, reproducible call in tests. */
const FIXED_REQUEST_ID = "req_test";

const baseReq: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

test("tool_input matches the SpendRequest shape", () => {
  assert.ok(isSpendRequest(baseReq));
});

test("makeFakeReceipt emits a submitted receipt echoing the request", () => {
  const receipt = makeFakeReceipt(baseReq, FIXED_REQUEST_ID);
  assert.equal(receipt.status, "submitted");
  assert.match(receipt.receiptId, /^rcpt_[0-9a-f]{8}$/);
  assert.equal(receipt.vendorId, baseReq.vendorId);
  assert.equal(receipt.amount, baseReq.amount);
  assert.equal(receipt.currency, baseReq.currency);
  assert.equal(receipt.category, baseReq.category);
  assert.equal(receipt.requestingAgent, baseReq.requestingAgent);
  assert.equal(receipt.invoiceRef, baseReq.invoiceRef);
});

test("receipt id is deterministic for identical requests", () => {
  const a = makeFakeReceipt(baseReq, FIXED_REQUEST_ID);
  const b = makeFakeReceipt({ ...baseReq }, FIXED_REQUEST_ID);
  assert.equal(a.receiptId, b.receiptId);
});

test("receipt id changes when a request field changes", () => {
  const a = makeFakeReceipt(baseReq, FIXED_REQUEST_ID);
  const b = makeFakeReceipt({ ...baseReq, amount: 341 }, FIXED_REQUEST_ID);
  assert.notEqual(a.receiptId, b.receiptId);
});

test("omitting the optional invoiceRef omits it from the receipt", () => {
  const { invoiceRef: _drop, ...withoutInvoice } = baseReq;
  const receipt = makeFakeReceipt(withoutInvoice, FIXED_REQUEST_ID);
  assert.equal(receipt.invoiceRef, undefined);
  assert.match(receipt.receiptId, /^rcpt_[0-9a-f]{8}$/);
});

test("newRequestId returns a req-prefixed UUID shape", () => {
  assert.match(
    newRequestId(),
    /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("newRequestId is unique per call (one id per attempt)", () => {
  assert.notEqual(newRequestId(), newRequestId());
});

test("makeFakeReceipt is pure and echoes the requestId passed in", () => {
  const a = makeFakeReceipt(baseReq, FIXED_REQUEST_ID);
  const b = makeFakeReceipt(baseReq, FIXED_REQUEST_ID);
  assert.deepEqual(a, b);
  assert.equal(a.requestId, FIXED_REQUEST_ID);
});

test("receiptId is independent of requestId", () => {
  const a = makeFakeReceipt(baseReq, "req_aaaa");
  const b = makeFakeReceipt(baseReq, "req_bbbb");
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(a.receiptId, b.receiptId);
});

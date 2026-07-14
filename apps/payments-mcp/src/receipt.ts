/**
 * @ramp/payments-mcp — fake receipt factory
 *
 * The `pay_vendor` tool is an HONEST STUB: no money moves, and this file NEVER
 * enforces policy (the PreToolUse hook does that, out of band). All this does is
 * mint a plausible-looking receipt so the tool has something to return.
 *
 * The receipt id is DETERMINISTIC — derived purely from the request fields via a
 * small non-cryptographic hash. No `Math.random`, no clock, no I/O. Identical
 * requests therefore produce identical receipt ids, which keeps demos and tests
 * reproducible.
 */
import { randomUUID } from "node:crypto";
import type { SpendRequest } from "@ramp/shared";

/**
 * Mint a fresh EXECUTION-scoped id for the receipt, e.g. "req_<uuid>". This is
 * minted only when the tool actually EXECUTES, and every call returns a new value
 * so each `pay_vendor` execution gets a distinct id for its receipt.
 *
 * It is NOT a policy-correlation id. Policy is decided by the PreToolUse hook
 * BEFORE this tool runs; the hook never sees this id, and there is no native
 * tool_use_id shared between the hook and the tool. Crucially, DENIED attempts
 * never reach execution, so they have no id of this kind at all — do not treat it
 * as a hook/policy correlation key.
 *
 * Uses `crypto.randomUUID()` — no `Math.random`, no clock, no counter.
 */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/** A fake payment receipt. `status` is always `"submitted"` for the stub. */
export interface FakeReceipt {
  /** Deterministic id derived from the request fields, e.g. "rcpt_a1b2c3d4". */
  readonly receiptId: string;
  /**
   * Execution-scoped id (e.g. "req_<uuid>"), minted at tool-execution time and
   * unique per execution. Unlike `receiptId`, it is NOT derived from the request —
   * it is minted fresh per execution and is deliberately kept OUT of the
   * `receiptId` fingerprint.
   *
   * It is NOT a policy-correlation id: the PreToolUse hook decides allow/deny
   * BEFORE the tool runs and never sees this id, and denied attempts (which never
   * execute) have no execution id at all.
   */
  readonly requestId: string;
  /** Always `"submitted"` — the stub never actually settles a payment. */
  readonly status: "submitted";
  /** Echo of the vendor being paid. */
  readonly vendorId: string;
  /** Echo of the requested amount (whole currency units). */
  readonly amount: number;
  /** Echo of the ISO 4217 currency code. */
  readonly currency: string;
  /** Echo of the spend category. */
  readonly category: string;
  /** Echo of the requesting agent. */
  readonly requestingAgent: string;
  /** Echo of the invoice reference, if the caller supplied one. */
  readonly invoiceRef?: string;
  /** Human-readable note making the stub nature explicit. */
  readonly note: string;
}

/**
 * FNV-1a (32-bit) hash of a string, returned as an unsigned integer. Small,
 * dependency-free, and deterministic — good enough to derive a stable receipt id.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to an unsigned 32-bit integer.
  return hash >>> 0;
}

/** Stable 8-char lowercase hex fingerprint of the request's identifying fields. */
function fingerprint(req: SpendRequest): string {
  // Join with a NUL ("\0") delimiter so the encoding is unambiguous: NUL cannot
  // appear in these text fields, so adjacent fields can never alias (e.g. agent
  // "ab" + vendor "c" no longer collides with agent "a" + vendor "bc").
  // invoiceRef is optional -> normalize to "".
  const canonical = [
    req.requestingAgent,
    req.vendorId,
    req.category,
    req.currency,
    String(req.amount),
    req.invoiceRef ?? "",
  ].join("\0");
  return fnv1a32(canonical).toString(16).padStart(8, "0");
}

/**
 * Build a deterministic fake receipt for a spend request. Pure function: same
 * `(req, requestId)` in -> same `FakeReceipt` out. No randomness, clock, or I/O.
 *
 * `requestId` is the execution-scoped id (see `newRequestId`); the caller mints it
 * once per execution and passes it in. It is echoed verbatim and does NOT feed the
 * `receiptId` fingerprint, so `receiptId` stays deterministic across identical
 * requests regardless of which `requestId` accompanies them. It is NOT a
 * policy-correlation id (the hook decides allow/deny before this ever runs).
 */
export function makeFakeReceipt(req: SpendRequest, requestId: string): FakeReceipt {
  const receipt: FakeReceipt = {
    receiptId: `rcpt_${fingerprint(req)}`,
    requestId,
    status: "submitted",
    vendorId: req.vendorId,
    amount: req.amount,
    currency: req.currency,
    category: req.category,
    requestingAgent: req.requestingAgent,
    note: "STUB receipt — no funds moved. Policy enforcement happens in the PreToolUse hook.",
    ...(req.invoiceRef !== undefined ? { invoiceRef: req.invoiceRef } : {}),
  };
  return receipt;
}

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
 * Mint a fresh per-attempt correlation id, e.g. "req_<uuid>". This is NOT
 * deterministic: every call returns a new value so each `pay_vendor` invocation
 * (one logical payment attempt) can be tracked distinctly. It must be generated
 * EXACTLY ONCE per attempt by the caller, then threaded through the receipt.
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
   * Per-attempt correlation id (e.g. "req_<uuid>"), unique to this invocation.
   * Unlike `receiptId`, this is NOT derived from the request — it is minted fresh
   * per attempt and is deliberately kept OUT of the `receiptId` fingerprint.
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
  // Join with a delimiter that cannot appear inside the numeric field so the
  // encoding is unambiguous. invoiceRef is optional -> normalize to "".
  const canonical = [
    req.requestingAgent,
    req.vendorId,
    req.category,
    req.currency,
    String(req.amount),
    req.invoiceRef ?? "",
  ].join("");
  return fnv1a32(canonical).toString(16).padStart(8, "0");
}

/**
 * Build a deterministic fake receipt for a spend request. Pure function: same
 * `(req, requestId)` in -> same `FakeReceipt` out. No randomness, clock, or I/O.
 *
 * `requestId` is the per-attempt correlation id (see `newRequestId`); the caller
 * generates it ONCE per attempt and passes it in. It is echoed verbatim and does
 * NOT feed the `receiptId` fingerprint, so `receiptId` stays deterministic across
 * identical requests regardless of which `requestId` accompanies them.
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

/**
 * @ramp/payments-mcp — SANDBOX payment executor
 *
 * Implements the frozen `PaymentExecutor` port from `@ramp/ledger`. This is a
 * CLEARLY-LABELED SANDBOX: it behaves like a payment provider adapter (it hands
 * back a settlement receipt) but NO REAL MONEY MOVES and NO REAL PROVIDER IS
 * CONTACTED. The `provider` field on every receipt is literally `"sandbox"` so
 * downstream code and audit records can never mistake it for a real charge.
 *
 * DETERMINISTIC + PURE: `execute` derives every field of the receipt from the
 * request alone via `sha256OfJson`. There is no `Math.random`, no clock, no I/O,
 * and no hidden state. The same `ExecutorRequest` therefore always yields a
 * byte-identical `ExecutorReceipt`, so idempotent retries (which reuse the same
 * `decisionId`/`idempotencyKey`) collapse to the same result.
 *
 * CREDENTIAL ISOLATION: this file holds NO secrets, card numbers, API keys, or
 * provider credentials, and the receipt it returns carries none either — its key
 * set is exactly {receiptId, executionId, status, provider}.
 *
 * ponytail: a REAL adapter (e.g. Stripe or the Ramp payments API) would read its
 * credentials from server-side environment/secret storage at call time and use
 * them only to talk to the provider over the wire. It would NEVER place those
 * credentials — or card numbers, tokens, or any secret — onto the receipt or
 * anywhere the model/agent can observe them. A real adapter would also typically
 * THROW on transport/network errors (timeouts, 5xx) rather than return a failed
 * receipt; the orchestration in `@ramp/ledger` treats an executor throw and a
 * `status:"failed"` receipt the same way (both -> `executor_error`).
 */
import {
  sha256OfJson,
  type PaymentExecutor,
  type ExecutorRequest,
  type ExecutorReceipt,
} from "@ramp/ledger";

/**
 * Deterministic settlement id derived from the money-moving identity of the
 * request (decision + vendor + amount + currency). 16 hex chars is plenty of
 * space to keep sandbox receipt ids visibly distinct while staying stable.
 */
function receiptIdFor(req: ExecutorRequest): string {
  const { vendorId, amount, currency } = req.request;
  return (
    "rcpt_" +
    sha256OfJson({ decisionId: req.decisionId, vendorId, amount, currency }).slice(0, 16)
  );
}

/**
 * Deterministic, execution-scoped id derived ONLY from `decisionId`. Because a
 * retry reuses the same `decisionId` (== idempotency key), the executionId is
 * stable across retries. It is namespaced ("execution") so it can never collide
 * with the receiptId digest for the same decision.
 */
function executionIdFor(req: ExecutorRequest): string {
  return "exec_" + sha256OfJson({ execution: req.decisionId }).slice(0, 16);
}

/**
 * A pure sandbox executor. `execute` is synchronous and deterministic; it always
 * "settles" (there is no real provider to fail). Use {@link makeSandboxExecutor}
 * with `failVendorIds` when you need to exercise the failure path.
 */
export class SandboxExecutor implements PaymentExecutor {
  /** Vendor ids for which the sandbox simulates a settlement failure. */
  private readonly failVendorIds: ReadonlySet<string>;

  constructor(opts?: { failVendorIds?: readonly string[] }) {
    this.failVendorIds = new Set(opts?.failVendorIds ?? []);
  }

  execute(req: ExecutorRequest): ExecutorReceipt {
    const failed = this.failVendorIds.has(req.request.vendorId);
    // The receipt key set is EXACTLY these four fields — no secret-bearing field
    // is present, by construction. `provider:"sandbox"` marks it as non-real.
    const receipt: ExecutorReceipt = {
      receiptId: receiptIdFor(req),
      executionId: executionIdFor(req),
      status: failed ? "failed" : "settled",
      provider: "sandbox",
    };
    return receipt;
  }
}

/**
 * Factory for a sandbox {@link PaymentExecutor}. Pass `failVendorIds` to make the
 * sandbox return a `status:"failed"` receipt (deterministically, not a throw) for
 * those vendors, so callers can exercise the orchestration's `executor_error`
 * path in a fully reproducible way.
 *
 * We return a FAILED RECEIPT rather than throwing so the failure stays pure and
 * testable. (See the file header: a real provider adapter would additionally
 * throw on transport errors; the `@ramp/ledger` orchestration handles both.)
 */
export function makeSandboxExecutor(opts?: {
  failVendorIds?: readonly string[];
}): PaymentExecutor {
  return new SandboxExecutor(opts);
}

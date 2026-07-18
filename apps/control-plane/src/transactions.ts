/**
 * @ramp/control-plane — UI-triggered transactions (REAL gated decisions)
 *
 * ============================================================================
 * A "SIMULATE TRANSACTION" IS A REAL GATED DECISION — NOT A FAKE ROW.
 * ============================================================================
 * The dashboard's Simulate panel POSTs an INTENT here (agent, vendor, amount,
 * category, and whether to attach a valid attestation). This module hands that
 * intent to the SAME `requestPurchase` lifecycle the hook and the MCP tool use
 * (via `@ramp/client`): the kernel decides allow/deny/escalate, both proofs are
 * sealed, and the decision is hash-chained into the append-only log. The result
 * then appears on the read-only dashboard through the real SSE feed — because it
 * is a genuine decision, not a fabricated row.
 *
 * The control plane NEVER writes a decision record itself and NEVER decides. It
 * only supplies the untrusted intent (identity/amount keys) and, for a "valid"
 * transaction, mints a demo attestation that binds to the vendor's registered
 * domain — exactly what an honest client would present. Make it "invalid" and the
 * gate denies it for a real reason (no attestation, unverified vendor, over cap,
 * uncleared category): the outcome falls out of policy, it is not chosen here.
 */
import type { RampClient } from "@ramp/client";
import type { SpendRequest } from "@ramp/shared";
import { LedgerFactSource, type LedgerDb } from "@ramp/ledger";

/** The intent the UI sends. Only identity/amount KEYS — never facts, never a verdict. */
export interface TxIntent {
  readonly agent: string;
  readonly vendor: string;
  readonly amount: number;
  readonly category: string;
  readonly currency?: string;
  /** Attach a VALID demo attestation (bound to the vendor's registered domain)? */
  readonly attest: boolean;
}

/** What the panel gets back: the real, recorded verdict. */
export interface TxResult {
  readonly status: string;
  readonly outcome: string | null;
  readonly decisionId: string | null;
  readonly firedRules: readonly string[];
  readonly reasons: readonly string[];
}

/** Validate an untrusted POST body into a `TxIntent`, or return a reason string. */
export function parseIntent(body: unknown): TxIntent | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.agent !== "string" || b.agent === "") return { error: "agent is required" };
  if (typeof b.vendor !== "string" || b.vendor === "") return { error: "vendor is required" };
  if (typeof b.category !== "string" || b.category === "") return { error: "category is required" };
  if (typeof b.amount !== "number" || !Number.isInteger(b.amount) || b.amount < 0) {
    return { error: "amount must be a whole, non-negative number (money is integer units)" };
  }
  if (typeof b.attest !== "boolean") return { error: "attest must be a boolean" };
  const currency = b.currency === undefined ? undefined : typeof b.currency === "string" ? b.currency : null;
  if (currency === null) return { error: "currency, if given, must be a string" };
  return { agent: b.agent, vendor: b.vendor, amount: b.amount, category: b.category, currency, attest: b.attest };
}

/**
 * Drive a real gated transaction. Returns the recorded verdict. Deterministic
 * `invoiceRef` per call (wall-clock is fine here — the control plane is a normal
 * process, not the pure kernel).
 */
export async function runTransaction(
  ramp: RampClient,
  db: LedgerDb,
  intent: TxIntent,
  now: number,
): Promise<TxResult> {
  const currency = intent.currency ?? "USD";
  const base: SpendRequest = {
    vendorId: intent.vendor,
    amount: intent.amount,
    currency,
    category: intent.category,
    requestingAgent: intent.agent,
    invoiceRef: `inv_ui_${now}`,
  };

  let request: SpendRequest = base;
  if (intent.attest) {
    // Bind the attestation to the vendor's REGISTERED domain (an authoritative
    // ledger read), so a "valid" attestation for a verified vendor clears the
    // domain-binding check. An unregistered vendor has no domain → the mint uses a
    // lookalike and the gate correctly denies (you can't attest an unknown vendor).
    const domain = new LedgerFactSource(db).getVendorDomain(intent.vendor) ?? `${intent.vendor}.example.com`;
    request = ramp.withDemoAttestation({ ...base, serverDomain: domain });
  }

  const r = await ramp.pay(request);
  return {
    status: r.status,
    outcome: r.outcome,
    decisionId: r.decisionId,
    firedRules: r.firedRules,
    reasons: r.reasons,
  };
}

/**
 * @ramp/shared — SpendRequest
 *
 * The RAW shape emitted by the MCP tool `mcp__payments__pay_vendor` (its
 * `tool_input`), BEFORE fact translation.
 *
 * ============================================================================
 * THIS IS UNTRUSTED TRANSPORT. ALL OF IT. INCLUDING THE CRYPTO.
 * ============================================================================
 * Every field here is supplied by, or influenced by, a model that can be
 * prompt-injected. The hook uses `requestingAgent`, `vendorId`, `amount`,
 * `category`, `invoiceRef` only as KEYS to look up authoritative facts.
 *
 * `invoiceDocument` and `attestation` are the two that look like exceptions and
 * are not:
 *   - `invoiceDocument` is attacker-authored prose. It is quarantined at the
 *     boundary (@ramp/quarantine) and never read as instructions. Its only role
 *     is to be DIGESTED, so the digest can be compared against the attestation.
 *   - `attestation` is a signed blob riding in on an untrusted channel. Arriving
 *     here grants it nothing. @ramp/attestation decides whether it is genuine
 *     and whether it BINDS to this payment; only the resulting boolean becomes
 *     the `attestation_present` fact. A request cannot assert that it is
 *     attested — it can only present bytes and be judged.
 *
 * The rule is uniform: this type carries claims, never facts.
 */
export interface SpendRequest {
  /** Vendor id the agent wants to pay, e.g. "acme_corp". Used as a registry key. */
  readonly vendorId: string;
  /** Requested amount in whole currency units. */
  readonly amount: number;
  /** ISO 4217 currency code, e.g. "USD". */
  readonly currency: string;
  /** Spend category asserted by the caller, e.g. "office_supplies". */
  readonly category: string;
  /** Reference to the invoice/attestation, e.g. "inv_2026_07_0043". Optional. */
  readonly invoiceRef?: string;
  /** Agent id making the request, e.g. "agent_47". Used as a ledger key. */
  readonly requestingAgent: string;
  /**
   * The invoice document as served by the vendor. UNTRUSTED PROSE — quarantined
   * on arrival and never interpreted. Its bytes exist to be hashed and checked
   * against the attestation's `invoiceDigest`, nothing more.
   */
  readonly invoiceDocument?: string;
  /**
   * A TLSNotary-style attestation over `invoiceDocument`. Opaque here on purpose
   * (`unknown`): this package is the contract and has zero runtime deps, so it
   * does not know the attestation's shape. @ramp/attestation validates and
   * verifies it. Typed as `unknown` rather than `Attestation` so no caller can
   * mistake "it type-checked" for "it verified".
   */
  readonly attestation?: unknown;
  /**
   * An optional Ed25519 signature proving the caller holds the private key for
   * `requestingAgent`. Opaque here on purpose (`unknown`): like `attestation`,
   * arriving here grants it nothing. The gate looks up the agent's REGISTERED
   * public key and, if the agent has one, refuses the request unless this
   * signature verifies against it (@ramp/attestation `verifyAgentRequest`).
   * Agents with no registered key are unauthenticated (legacy). A claim on an
   * untrusted channel, never a fact.
   */
  readonly agentSignature?: unknown;
}

/**
 * Minimal runtime guard the MCP server / hook uses to reject malformed tool_input.
 *
 * Note it does NOT validate `attestation` beyond "present or not" — validating
 * an attestation is @ramp/attestation's job, and a shape check here would be a
 * second, weaker verifier that a reader might mistake for the real one.
 */
export function isSpendRequest(value: unknown): value is SpendRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.vendorId === "string" &&
    typeof v.amount === "number" &&
    Number.isFinite(v.amount) &&
    typeof v.currency === "string" &&
    typeof v.category === "string" &&
    typeof v.requestingAgent === "string" &&
    (v.invoiceRef === undefined || typeof v.invoiceRef === "string") &&
    (v.invoiceDocument === undefined || typeof v.invoiceDocument === "string")
  );
}

/**
 * @ramp/shared — SpendRequest
 *
 * The RAW shape emitted by the MCP tool `mcp__payments__pay_vendor` (its
 * `tool_input`), BEFORE fact translation. This is untrusted transport: the hook
 * uses `requestingAgent`, `vendorId`, `amount`, `category`, `invoiceRef` only as
 * KEYS to look up authoritative facts — their values are never trusted as facts.
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
}

/** Minimal runtime guard the MCP server / hook uses to reject malformed tool_input. */
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
    (v.invoiceRef === undefined || typeof v.invoiceRef === "string")
  );
}

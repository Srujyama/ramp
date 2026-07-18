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
 * `invoiceDocument`, `attestation` and `identity` are the three that look like
 * exceptions and are not:
 *   - `invoiceDocument` is attacker-authored prose. It is quarantined at the
 *     boundary (@ramp/quarantine) and never read as instructions. Its only role
 *     is to be DIGESTED, so the digest can be compared against the attestation.
 *   - `attestation` is a signed blob riding in on an untrusted channel. Arriving
 *     here grants it nothing. @ramp/attestation decides whether it is genuine
 *     and whether it BINDS to this payment; only the resulting boolean becomes
 *     the `attestation_present` fact. A request cannot assert that it is
 *     attested — it can only present bytes and be judged.
 *   - `identity` is the same shape of thing for WHO IS ASKING. It is a signature
 *     CLAIM, not an identity: @ramp/attestation's `verifyAgentIdentity` judges it
 *     against the public key the LEDGER's agent registry holds for
 *     `requestingAgent`, and only the resulting boolean becomes the
 *     `agent_identity_verified` fact. A request cannot assert who sent it — it
 *     can only present a signature and be judged against the registered key.
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
   * The requesting agent's signature over this request's IDENTITY CORE — the
   * fields that name what is being paid and who is asking (see
   * @ramp/attestation's `agentIdentityCore`). Base64 Ed25519.
   *
   * A CLAIM, exactly like `attestation`: presenting one grants nothing. The gate
   * looks up the public key the agent registry holds for `requestingAgent`
   * (status 'active' only) and verifies the signature against it; a missing,
   * malformed, or wrong-key signature — or an unregistered/revoked agent — all
   * collapse to `agent_identity_verified: false`, and the kernel denies
   * (`deny/unauthenticated_agent`). The scheme tag exists so the verification
   * seam can later carry other proof kinds (SPIFFE SVIDs, signed JWTs) without
   * reshaping the transport.
   */
  readonly identity?: {
    readonly scheme: "ed25519";
    readonly signature: string;
  };
}

/**
 * Minimal runtime guard the MCP server / hook uses to reject malformed tool_input.
 *
 * Note it does NOT validate `attestation` beyond "present or not" — validating
 * an attestation is @ramp/attestation's job, and a shape check here would be a
 * second, weaker verifier that a reader might mistake for the real one. The
 * `identity` check below is likewise SHAPE only ("is this a well-formed claim"),
 * never verification — whether the signature is genuine is decided against the
 * registry key by `verifyAgentIdentity`, out of band.
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
    (v.invoiceDocument === undefined || typeof v.invoiceDocument === "string") &&
    (v.identity === undefined || isIdentityClaim(v.identity))
  );
}

/** Shape check for the optional identity claim. Total; never throws. */
function isIdentityClaim(value: unknown): value is NonNullable<SpendRequest["identity"]> {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return c.scheme === "ed25519" && typeof c.signature === "string";
}

/**
 * @ramp/attestation — agent identity (registered-key request signing)
 *
 * ============================================================================
 * WHO IS ASKING, PROVEN RATHER THAN TYPED
 * ============================================================================
 * `SpendRequest.requestingAgent` was always an untrusted string: any caller
 * could write `"agent_47"` and be judged under agent_47's clearances, budgets,
 * and daily headroom. Every other identity in this repo already obeys the
 * stronger rule — the notary is a registered key, the gate signature is a
 * registered key, the APPROVER is "whichever registered key verifies, never a
 * `--by` flag" — and this module brings the requesting agent under the same
 * rule. An agent signs the identity core of each request with its private key;
 * the gate verifies the signature against the public key the LEDGER's
 * `agent_registry` holds for that agent id. Only the verdict becomes the
 * `agent_identity_verified` fact, and the kernel denies on false
 * (`deny/unauthenticated_agent`). Impersonation now requires the agent's
 * private key, not its name.
 *
 * ============================================================================
 * WHY REGISTERED-KEY SIGNING, AND NOT OAUTH / JWT / SPIFFE / mTLS
 * ============================================================================
 * The gate is an offline subprocess that must FAIL CLOSED with zero external
 * dependencies: there is no token issuer, no CA, and no network available (or
 * wanted) on the decision path — a gate that must phone home to decide is a
 * gate that fails open or fails dark. Every one of those schemes ultimately
 * reduces to "verify a signature against a public key you already trust"; a
 * registry of public keys IS that primitive, minus the moving parts, and the
 * repo already carries the exact machinery (Ed25519 via node:crypto, a
 * keyed registry as the trust decision — see the notary keyring and the
 * approver keyring).
 *
 * THE SWAP SEAM: `verifyAgentIdentity` is the ONE function that judges an
 * identity claim. A deployment that wants SPIFFE SVIDs, signed JWTs, or an
 * mTLS-derived identity swaps this function's internals (and the registry's
 * key material) — the kernel, the fact translation, and both gates are
 * unchanged, because they only ever see the boolean verdict. That is the same
 * seam shape as `verifyAttestation`: mechanism here, trust decision in the
 * registry, verdict in the Facts.
 *
 * WHAT THE SIGNATURE COVERS — the IDENTITY CORE: vendorId, amount, currency,
 * category, invoiceRef, requestingAgent. That is the money-moving intent; a
 * signature over it cannot be replayed onto a different payment (change the
 * amount and the signature dies). `invoiceDocument` and `attestation` are
 * deliberately EXCLUDED: they are judged by their own layers (quarantine and
 * attestation verification), and the invoice document can be arbitrarily large
 * attacker-authored prose — an identity proof should not have to hash a novel.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson, type SpendRequest } from "@ramp/shared";

/**
 * Domain separation tag. The signature is over
 * `ramp.agent-identity.v1\n<canonical core>` — never the bare core, or a
 * signature the agent's key produced for any other purpose could be replayed
 * as an identity proof. Changing this invalidates every prior signature — by
 * design.
 */
export const AGENT_IDENTITY_DOMAIN = "ramp.agent-identity.v1";

/**
 * The identity core: the fields the agent's signature binds together. A
 * closed, ordered-by-canonicalJson projection of the request — nothing here is
 * optional except `invoiceRef`, which canonicalises to `""` so "no reference"
 * is a signed statement rather than an ambiguity.
 */
export function agentIdentityCore(request: SpendRequest): {
  readonly vendorId: string;
  readonly amount: number;
  readonly currency: string;
  readonly category: string;
  readonly invoiceRef: string;
  readonly requestingAgent: string;
} {
  return {
    vendorId: request.vendorId,
    amount: request.amount,
    currency: request.currency,
    category: request.category,
    invoiceRef: request.invoiceRef ?? "",
    requestingAgent: request.requestingAgent,
  };
}

/** The exact bytes signed and verified. Both sides call THIS — no second way. */
export function agentIdentitySigningBytes(request: SpendRequest): Buffer {
  return Buffer.from(
    `${AGENT_IDENTITY_DOMAIN}\n${canonicalJson(agentIdentityCore(request))}`,
    "utf8",
  );
}

/**
 * Sign a request as an agent: returns a copy carrying the `identity` claim.
 * Used by @ramp/client (which signs every request automatically) and the demo.
 *
 * The GATE never needs this function. If you find it imported on an
 * enforcement path, something has gone wrong: a verifier that can sign is a
 * verifier that can forge what it verifies.
 */
export function signSpendRequest(
  request: SpendRequest,
  privateKey: KeyObject,
): SpendRequest {
  return {
    ...request,
    identity: {
      scheme: "ed25519",
      signature: cryptoSign(null, agentIdentitySigningBytes(request), privateKey).toString(
        "base64",
      ),
    },
  };
}

/**
 * THE VERIFICATION SEAM. Judge a request's identity claim against the public
 * key the agent registry holds for `request.requestingAgent`.
 *
 * The caller (the hook / the MCP gate / the SDK) looks the key up in the
 * LEDGER's `agent_registry` — status 'active' only — and passes the PEM here.
 * `null` means "no registered key" (unknown or revoked agent) and is a
 * rejection: an identity nobody registered can never verify.
 *
 * TOTAL and PURE: any input shape yields a boolean, never a throw — this runs
 * on the enforcement path, where a throw is a denial-of-service; and no clock,
 * I/O, or randomness, so the same request + key always yields the same
 * verdict. False for: missing claim, unsupported scheme, malformed base64, a
 * signature over different bytes (any tampered core field), or a signature by
 * any key other than the registered one.
 */
export function verifyAgentIdentity(
  request: SpendRequest,
  publicKeyPem: string | null | undefined,
): boolean {
  if (publicKeyPem === null || publicKeyPem === undefined) return false;
  const claim = request.identity;
  if (claim === undefined || claim === null) return false;
  if (claim.scheme !== "ed25519" || typeof claim.signature !== "string") return false;
  try {
    return cryptoVerify(
      null, // Ed25519 selects its own hash; null is correct here.
      agentIdentitySigningBytes(request),
      createPublicKey(publicKeyPem),
      Buffer.from(claim.signature, "base64"),
    );
  } catch {
    // Unparseable PEM, malformed base64, wrong key type — a rejection, never a throw.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Demo agent keypairs. Derived from published constants — worthless by
// construction, exactly like the demo notary / gate / approver keys, and for
// the same reasons: a committed private-key PEM trips every secret scanner
// forever and looks exactly like a production credential. The PUBLIC halves
// are seeded into the ledger's agent_registry (sql/seed.sql) so `pnpm demo`
// works out of the box; a test pins that the seeded PEMs match this
// derivation. A REAL deployment registers keys whose private halves live with
// the agent runtime (HSM / workload identity) — the verification code above is
// unchanged.
// ---------------------------------------------------------------------------

const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/** The agent ids the demo seed registers keys for. */
export const DEMO_AGENT_IDS = [
  "agent_47",
  "agent_12",
  "agent_burst",
  "agent_dup",
  "agent_23",
  "agent_08",
] as const;

/** The published derivation phrase for a demo agent's key. NOT a secret. */
function demoAgentPhrase(agentId: string): string {
  return `ramp.demo.agent.${agentId}.v1 — public by design, worthless by construction`;
}

/** A demo agent's keypair: the private KeyObject + the SPKI public PEM. */
export interface DemoAgentKeypair {
  readonly agentId: string;
  /** For the agent/SDK/demo side only — never the gate. */
  readonly privateKey: KeyObject;
  /** The SPKI PEM the agent_registry stores. The only half a verifier needs. */
  readonly publicKeyPem: string;
}

/**
 * Deterministically derive a demo agent's Ed25519 keypair from its published
 * phrase. Works for ANY agent id (a test can mint `agent_ghost`'s "key" and
 * watch the registry reject the unregistered identity) — but only the
 * {@link DEMO_AGENT_IDS} are actually registered by the seed.
 */
export function demoAgentKeypair(agentId: string): DemoAgentKeypair {
  const seed = createHash("sha256").update(demoAgentPhrase(agentId), "utf8").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyPem = createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  }) as string;
  return { agentId, privateKey, publicKeyPem };
}

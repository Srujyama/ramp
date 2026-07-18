/**
 * @ramp/attestation — authenticated caller identity (closes the impersonation hole)
 *
 * ============================================================================
 * `requestingAgent` IS UNTRUSTED TRANSPORT. THIS IS HOW WE BIND IT TO A CALLER.
 * ============================================================================
 * A `SpendRequest`'s `requestingAgent` field is a plain string on an untrusted
 * channel — any process can put `"agent_47"` there. The kernel only ever uses it
 * as a KEY to look up facts the caller cannot shrink, so claiming an id never
 * *escalates* privilege. But nothing authenticated WHICH caller presented the id,
 * so two processes could both act as `agent_47`.
 *
 * This module closes that. Once an agent is ISSUED a keypair — its PUBLIC key
 * registered in the ledger — the gate refuses any request naming that agent that
 * is not signed by its PRIVATE key. The signature binds the caller's key to the
 * request's identity + intent (agent, vendor, amount, currency, category, ref)
 * and is freshness-bound to defeat replay. Verified BEFORE the id is trusted,
 * exactly like the attestation and `isSpendRequest` preconditions in the hook.
 *
 * Scope, stated plainly (the same honesty the rest of this package holds to):
 * this is a real Ed25519, domain-separated, freshness-bound binding of "who is
 * calling" to "which agent." It is NOT a full workload-identity / OAuth / mTLS
 * stack. Agents with no registered key remain UNAUTHENTICATED (legacy) — the
 * feature is opt-in per agent, so issuing a key is what turns enforcement on.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson } from "@ramp/shared";

/** Domain-separation tag. A signature made for any other purpose is not over these bytes. */
export const AGENT_REQUEST_DOMAIN = "ramp.agent-request.v1";

/** How old a request signature may be before it is treated as a replay. */
export const AGENT_SIGNATURE_MAX_AGE_MS = 5 * 60_000;
/** Tolerated clock skew for a future-dated signature. */
export const AGENT_SIGNATURE_SKEW_MS = 60_000;

/** DER prefix for an Ed25519 PKCS#8 private key (RFC 8410) — see notary.ts. */
const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Published seed for the demo agent keys — "public by design, worthless by
 * construction," exactly like the demo notary key (see notary.ts). Each agent's
 * demo keypair is this phrase salted with the agent id, so keys are distinct,
 * reproducible, and obviously not secrets. A real deployment issues real keys per
 * agent and stores only the public half in the registry.
 */
const DEMO_AGENT_SEED_PHRASE =
  "ramp.demo.agent.v1 — public by design, worthless by construction";

/** The minimal request shape a signature binds: everything that decides who + what. */
export interface SignableRequest {
  readonly requestingAgent: string;
  readonly vendorId: string;
  readonly amount: number;
  readonly currency: string;
  readonly category: string;
  readonly invoiceRef?: string;
}

/** A detached signature the caller attaches to a request as `agentSignature`. */
export interface AgentRequestSignature {
  /** Informational key id, e.g. `agent_demo_ed25519_agent_47`. */
  readonly keyId: string;
  /** ISO-8601 time the caller signed — freshness-bound to defeat replay. */
  readonly signedAt: string;
  /** base64 Ed25519 signature over the domain-separated canonical statement. */
  readonly signature: string;
}

/** Verdict of {@link verifyAgentRequest}. Total: never throws. */
export type AgentAuthResult =
  | { readonly authenticated: true; readonly keyId: string }
  | { readonly authenticated: false; readonly code: string; readonly reason: string };

/**
 * The exact statement bound by the signature. Nothing here is a fact the kernel
 * gates on — it is the caller's identity + intent, so a signature for one
 * request cannot be replayed onto a different amount, vendor, or agent.
 */
function agentStatement(req: SignableRequest, signedAt: string): unknown {
  return {
    domain: AGENT_REQUEST_DOMAIN,
    requestingAgent: req.requestingAgent,
    vendorId: req.vendorId,
    amount: req.amount,
    currency: req.currency,
    category: req.category,
    invoiceRef: req.invoiceRef ?? null,
    signedAt,
  };
}

/** The exact bytes both sides sign/verify. Domain tag + newline + canonical statement. */
function agentSigningBytes(req: SignableRequest, signedAt: string): Buffer {
  return Buffer.from(
    `${AGENT_REQUEST_DOMAIN}\n${canonicalJson(agentStatement(req, signedAt))}`,
    "utf8",
  );
}

/** Runtime guard for an untrusted `agentSignature` blob. */
export function isAgentSignature(value: unknown): value is AgentRequestSignature {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.keyId === "string" &&
    typeof v.signedAt === "string" &&
    typeof v.signature === "string"
  );
}

/**
 * Sign a request with an agent's private key. `signedAt` is injectable so tests
 * and the seeded demo are byte-reproducible; the clock is the caller's, never the
 * verifier's (the verifier only checks freshness against its own `now`).
 */
export function signAgentRequest(
  req: SignableRequest,
  opts: { readonly privateKey: KeyObject; readonly keyId: string; readonly signedAt: string },
): AgentRequestSignature {
  const signature = edSign(null, agentSigningBytes(req, opts.signedAt), opts.privateKey).toString(
    "base64",
  );
  return { keyId: opts.keyId, signedAt: opts.signedAt, signature };
}

/**
 * Verify that `signature` was produced by `publicKey` over exactly this request,
 * recently. A TOTAL function: a malformed blob, bad base64, wrong key, tampered
 * field, or stale timestamp all return `authenticated: false` — never a throw, so
 * the enforcement path can treat "did not authenticate" uniformly and fail closed.
 */
export function verifyAgentRequest(
  req: SignableRequest,
  signature: unknown,
  opts: {
    readonly publicKey: KeyObject;
    readonly now: number;
    readonly maxAgeMs?: number;
    readonly skewMs?: number;
  },
): AgentAuthResult {
  if (!isAgentSignature(signature)) {
    return { authenticated: false, code: "missing_signature", reason: "no agent signature present" };
  }
  const signedMs = Date.parse(signature.signedAt);
  if (!Number.isFinite(signedMs)) {
    return { authenticated: false, code: "bad_timestamp", reason: "signedAt is not a valid ISO timestamp" };
  }
  const maxAge = opts.maxAgeMs ?? AGENT_SIGNATURE_MAX_AGE_MS;
  const skew = opts.skewMs ?? AGENT_SIGNATURE_SKEW_MS;
  if (signedMs > opts.now + skew) {
    return { authenticated: false, code: "future_dated", reason: "signature is future-dated" };
  }
  if (opts.now - signedMs > maxAge) {
    return { authenticated: false, code: "expired", reason: "signature is stale (replay window exceeded)" };
  }
  let ok = false;
  try {
    ok = edVerify(
      null,
      agentSigningBytes(req, signature.signedAt),
      opts.publicKey,
      Buffer.from(signature.signature, "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    return { authenticated: false, code: "bad_signature", reason: "signature does not verify for this agent's registered key" };
  }
  return { authenticated: true, keyId: signature.keyId };
}

/** Encode a public key for the registry column (base64 SPKI DER — single line, SQL-friendly). */
export function encodeAgentPublicKey(key: KeyObject): string {
  return (key.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

/** Rebuild a public key from the registry column value. Throws on a malformed value. */
export function agentPublicKeyFromRegistry(encoded: string): KeyObject {
  return createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
}

// ============================================================================
// DEMO AGENT KEYS — derived, not stored (same rationale as the demo notary key)
// ============================================================================

/** Stable key id for an agent's demo key. */
export function demoAgentKeyId(agentId: string): string {
  return `agent_demo_ed25519_${agentId}`;
}

function derivedDemoAgentPrivateKey(agentId: string): KeyObject {
  const seed = createHash("sha256")
    .update(`${DEMO_AGENT_SEED_PHRASE} #${agentId}`, "utf8")
    .digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The demo private key for `agentId` — for the SDK, tests, and the seed generator only. */
export function demoAgentPrivateKey(agentId: string): KeyObject {
  return derivedDemoAgentPrivateKey(agentId);
}

/** The demo PUBLIC key for `agentId` — the only half the gate/registry needs. */
export function demoAgentPublicKey(agentId: string): KeyObject {
  return createPublicKey(derivedDemoAgentPrivateKey(agentId));
}

/** Convenience: sign a request as `agentId` with its demo key. */
export function signAgentRequestDemo(
  req: SignableRequest,
  agentId: string,
  signedAt: string,
): AgentRequestSignature {
  return signAgentRequest(req, {
    privateKey: demoAgentPrivateKey(agentId),
    keyId: demoAgentKeyId(agentId),
    signedAt,
  });
}

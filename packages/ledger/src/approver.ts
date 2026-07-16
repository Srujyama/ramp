/**
 * @ramp/ledger — approver.ts (WHO approved, established rather than claimed)
 *
 * ============================================================================
 * THE GAP THIS CLOSES
 * ============================================================================
 * `resolveEscalation` took `approvedBy: string`. Anyone who could run the CLI
 * could type `--by alice`, and the ledger recorded "alice" forever. The docs said
 * so honestly — "RECORDED, not authenticated" — but an approval trail that reads
 * as authoritative and is actually "whoever ran the command" is exactly the thing
 * that gets mistaken for a control. Being honest in a comment does not make the
 * trail true; it just means the lie is documented.
 *
 * So identity is now DERIVED FROM A SIGNATURE, never accepted as a parameter.
 * You do not tell the ledger who you are. You prove it, or you do not approve.
 *
 * This is the same rule the rest of the codebase already lives by, arriving
 * somewhere it should have been from the start:
 *   - facts come from the ledger, not the model's narration
 *   - the attestation's domain is checked against the REGISTRY, not the blob
 *   - the approval's facts digest comes from the ROW, not the caller
 *   - and now: the approver's identity comes from the KEY, not the flag
 *
 * ============================================================================
 * WHAT THIS DOES AND DOESN'T FIX
 * ============================================================================
 * FIXES: you cannot claim to be alice without alice's key. The keyring is the
 * trust decision — an approval signed by a key nobody registered is rejected, no
 * matter how valid the signature is mathematically.
 *
 * DOES NOT FIX: whoever holds alice's key IS alice, as far as this code can tell.
 * That is what a key means. Key custody (an HSM, a hardware token, an SSO-minted
 * short-lived key) is a deployment decision and this module deliberately does not
 * pretend to make it — it takes a keyring and checks signatures.
 *
 * The demo keys are derived from published constants and are therefore worthless,
 * exactly like the demo notary and gate keys. In the demo, anyone can still
 * "be alice" — by using the published alice key. The difference is that the
 * MECHANISM is now real: swap the keyring for one whose private halves live in an
 * HSM and the claim becomes true, with no change to this file.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson } from "@ramp/shared";

/**
 * Domain separation. An approval signature is over
 * `ramp.approval.v1\n<canonical statement>` — never the bare statement, or a
 * signature the approver's key produced for some other purpose could be replayed
 * as an approval.
 */
export const APPROVAL_DOMAIN = "ramp.approval.v1";

/** What an approver signs: this decision, this verdict, these exact facts. */
export interface ApprovalStatement {
  readonly schema: "ramp/approval-v1";
  readonly decisionId: string;
  readonly verdict: "approved" | "rejected";
  /**
   * The decision's `content_digest` at the moment of approval.
   *
   * Inside the signature on purpose. Without it, a signed "I approve decision X"
   * would be transferable to whatever X's facts later became — the $1-approval-
   * for-$50,000 attack, wearing a valid signature.
   */
  readonly factsDigest: string;
  /** Free-text note. Signed so it cannot be edited after the fact. */
  readonly note: string | null;
  readonly at: string;
}

/** A signed approval: the statement plus proof of who made it. */
export interface SignedApproval {
  readonly statement: ApprovalStatement;
  /** Which approver key signed. Selects a key; grants nothing by itself. */
  readonly approverKeyId: string;
  /** Base64 Ed25519 signature over `approvalSigningBytes(statement)`. */
  readonly signature: string;
}

/** A trusted approver: their key, and who they are. */
export interface Approver {
  /** The human this key belongs to, as the ORG says — not as the signer claims. */
  readonly identity: string;
  readonly publicKey: KeyObject;
}

/** The exact bytes signed and verified. Both sides call THIS. */
export function approvalSigningBytes(statement: ApprovalStatement): Buffer {
  return Buffer.from(`${APPROVAL_DOMAIN}\n${canonicalJson(statement)}`, "utf8");
}

/** Sign an approval statement as an approver. */
export function signApproval(
  statement: ApprovalStatement,
  privateKey: KeyObject,
  approverKeyId: string,
): SignedApproval {
  return {
    statement,
    approverKeyId,
    signature: sign(null, approvalSigningBytes(statement), privateKey).toString("base64"),
  };
}

/** Why an approval signature was rejected. */
export type ApproverFailure = "malformed" | "unknown_approver" | "bad_signature";

export type ApproverCheck =
  | {
      readonly ok: true;
      /**
       * Who approved — read from the KEYRING entry the signature matched, NOT from
       * the statement. A signer cannot name themselves.
       */
      readonly identity: string;
      readonly approverKeyId: string;
    }
  | { readonly ok: false; readonly code: ApproverFailure; readonly detail: string };

/** Total structural check. Any shape yields a verdict, never a throw. */
function looksLikeSignedApproval(v: unknown): v is SignedApproval {
  if (typeof v !== "object" || v === null) return false;
  const a = v as SignedApproval;
  if (typeof a.approverKeyId !== "string" || typeof a.signature !== "string") return false;
  const s = a.statement;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.decisionId === "string" &&
    (s.verdict === "approved" || s.verdict === "rejected") &&
    typeof s.factsDigest === "string" &&
    typeof s.at === "string"
  );
}

/**
 * Establish WHO approved, from the signature.
 *
 * Note what is not a parameter: an identity. The caller cannot tell us who they
 * are; we work it out from which trusted key verified. That inversion is the
 * whole point of this module.
 *
 * @param keyring trusted approvers, supplied OUT OF BAND. A keyring read from the
 *   approval itself would prove nothing — a forger includes their own key.
 *
 * Total: malformed input is a verdict, never a throw.
 */
export function checkApprover(
  approval: unknown,
  keyring: ReadonlyMap<string, Approver>,
): ApproverCheck {
  if (!looksLikeSignedApproval(approval)) {
    return { ok: false, code: "malformed", detail: "not a well-formed SignedApproval" };
  }

  const approver = keyring.get(approval.approverKeyId);
  if (!approver) {
    // The keyring IS the trust decision. An attacker signs perfectly well with
    // their own key; it fails here because the question is not "is this signed?"
    // but "is this signed by someone the org registered as an approver?"
    return {
      ok: false,
      code: "unknown_approver",
      detail: `approver key "${approval.approverKeyId}" is not a registered approver`,
    };
  }

  let valid = false;
  try {
    valid = verify(
      null,
      approvalSigningBytes(approval.statement),
      approver.publicKey,
      Buffer.from(approval.signature, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      ok: false,
      code: "bad_signature",
      detail: "the signature does not verify over the approval statement",
    };
  }

  // Identity comes from the KEYRING, not the statement. Even a validly-signed
  // approval cannot rename its signer.
  return { ok: true, identity: approver.identity, approverKeyId: approval.approverKeyId };
}

// ---------------------------------------------------------------------------
// Demo approvers. Derived from published constants — worthless by construction,
// exactly like the demo notary and gate keys, and for the same reasons: a
// committed PEM trips every scanner forever and looks like a real credential.
// ---------------------------------------------------------------------------

const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/** Derive a demo keypair from a published phrase. NOT a secret. */
function demoKeyFromPhrase(phrase: string): KeyObject {
  const seed = createHash("sha256").update(phrase, "utf8").digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The demo approvers the seeded org trusts. */
export const DEMO_APPROVERS: ReadonlyArray<{ keyId: string; identity: string; phrase: string }> = [
  { keyId: "approver_alice", identity: "alice", phrase: "ramp.demo.approver.alice.v1 — public by design" },
  { keyId: "approver_bob", identity: "bob", phrase: "ramp.demo.approver.bob.v1 — public by design" },
];

/** A demo approver's PRIVATE key, for the CLI and tests. */
export function demoApproverPrivateKey(keyId: string): KeyObject {
  const entry = DEMO_APPROVERS.find((a) => a.keyId === keyId);
  if (!entry) throw new Error(`no demo approver "${keyId}"`);
  return demoKeyFromPhrase(entry.phrase);
}

/**
 * The demo approver keyring: who the org trusts to approve.
 *
 * In the demo anyone can still "be alice" — by using the published alice key.
 * That is fine and expected; the point is that the MECHANISM is real. Swap this
 * for a keyring whose private halves live in an HSM and the claim becomes true
 * with no change to the verification code.
 */
export function demoApproverKeyring(): ReadonlyMap<string, Approver> {
  return new Map(
    DEMO_APPROVERS.map((a) => [
      a.keyId,
      { identity: a.identity, publicKey: createPublicKey(demoKeyFromPhrase(a.phrase)) },
    ]),
  );
}

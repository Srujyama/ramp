/**
 * @ramp/control-plane — ledger integrity & tamper-evidence.
 *
 * ============================================================================
 * THE CERTIFICATE-TRANSPARENCY GUARANTEE, IN THREE CALLS.
 * ============================================================================
 * The decision log is a hash chain: each entry commits to the previous, so no
 * single record can be altered without breaking every link after it. But a
 * self-consistent FULL rewrite (redo the chain from scratch) passes an internal
 * walk — `verifyChain` can't catch it, because it's internally flawless. The
 * defence is an EXTERNAL witness: publish a signed (head, length) receipt
 * somewhere you don't control, and later prove today's chain still has that head
 * as a PREFIX. A rewrite can't reproduce the earlier head; a truncation can't
 * reach the earlier length.
 *
 * This module exposes that read-only:
 *   - chainStatus  — current head + length + an internal-consistency walk.
 *   - makeReceipt  — a signed head receipt to publish (download + keep off-box).
 *   - checkReceipt — prove a previously-published receipt is still a prefix.
 * None of it writes; the receipt is signed with the demo gate key.
 */
import { chainHead, verifyChain, publishHead, verifyAgainstReceipt, type LedgerDb } from "@ramp/ledger";
import { demoGatePrivateKey, demoGateKeyring, DEMO_GATE_KEY_ID } from "@ramp/provenance";

/** Current chain head + length + an internal-consistency verdict. */
export function chainStatus(db: LedgerDb): { head: string; length: number; valid: boolean; defects: number } {
  const { head, length } = chainHead(db);
  const v = verifyChain(db);
  return { head, length, valid: v.valid, defects: v.defects.length };
}

/** A signed receipt for the current head — publish it somewhere you don't control. */
export function makeReceipt(db: LedgerDb, at: string): ReturnType<typeof publishHead> {
  return publishHead(db, demoGatePrivateKey(), DEMO_GATE_KEY_ID, at);
}

/** Prove a previously-published receipt is still a prefix of today's chain. */
export function checkReceipt(db: LedgerDb, body: unknown): ReturnType<typeof verifyAgainstReceipt> | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a head receipt" };
  const receipt = "receipt" in (body as Record<string, unknown>) ? (body as { receipt: unknown }).receipt : body;
  return verifyAgainstReceipt(db, receipt, demoGateKeyring());
}

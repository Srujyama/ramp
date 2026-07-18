/**
 * @ramp/control-plane — human resolution of held (escalated) decisions.
 *
 * ============================================================================
 * THE HUMAN CHANNEL — RECORDED WITH A REAL SIGNATURE, NOT A CLAIM.
 * ============================================================================
 * An `escalate`/held decision is the one thing an agent CANNOT resolve — a human
 * must. `resolveEscalation` refuses anything that isn't a genuine Ed25519-signed
 * approval from a key the org trusts, bound to the decision's exact content digest
 * (so a $1 approval can't be replayed against a $50,000 payment). This module is
 * the demo operator's door to that channel: it takes {decisionId, verdict,
 * approverKeyId, note}, mints the SIGNED approval statement with the selected demo
 * approver's key (exactly as the `pnpm approve` CLI does — the key is the identity,
 * not the string), and calls `resolveEscalation`.
 *
 * This is NOT an MCP-reachable path and NEVER writes a decision — it appends a
 * human approval record, the one write the agent side can only ever READ.
 */
import {
  resolveEscalation,
  listPendingEscalations,
  approvalFor,
  signApproval,
  demoApproverKeyring,
  demoApproverPrivateKey,
  DEMO_APPROVERS,
  ApprovalError,
  type LedgerDb,
  type ApprovalStatement,
  type ApprovalRecord,
} from "@ramp/ledger";

const VALID_KEYS = new Set(DEMO_APPROVERS.map((a) => a.keyId));

/** The approvers a demo operator can act as — surfaced so the UI can offer them. */
export function listApprovers(): Array<{ keyId: string; identity: string }> {
  return DEMO_APPROVERS.map((a) => ({ keyId: a.keyId, identity: a.identity }));
}

/** The queue of held decisions still awaiting a human. */
export function listPending(db: LedgerDb): ReturnType<typeof listPendingEscalations> {
  return listPendingEscalations(db);
}

export interface ResolveBody {
  readonly decisionId: string;
  readonly verdict: "approved" | "rejected";
  readonly approverKeyId: string;
  readonly note?: string | null;
}

export function parseResolveBody(body: unknown): ResolveBody | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.decisionId !== "string" || b.decisionId === "") return { error: "decisionId is required" };
  if (b.verdict !== "approved" && b.verdict !== "rejected") return { error: "verdict must be 'approved' or 'rejected'" };
  if (typeof b.approverKeyId !== "string" || !VALID_KEYS.has(b.approverKeyId)) {
    return { error: `approverKeyId must be one of: ${[...VALID_KEYS].join(", ")}` };
  }
  const note = b.note == null ? null : typeof b.note === "string" ? b.note : undefined;
  if (note === undefined) return { error: "note, if given, must be a string" };
  return { decisionId: b.decisionId, verdict: b.verdict, approverKeyId: b.approverKeyId, note };
}

/**
 * Resolve a held decision as a chosen demo approver. Reads the decision's own
 * content digest to BIND the approval to it, signs the statement with that
 * approver's key, and records it through the real human-channel path. Returns the
 * recorded approval, or a typed error (unknown decision, not held, already
 * resolved, self-approval — all straight from `resolveEscalation`).
 */
export function runResolve(db: LedgerDb, body: unknown, now: string): ApprovalRecord | { error: string; code?: string } {
  const parsed = parseResolveBody(body);
  if ("error" in parsed) return parsed;

  const row = db
    .prepare("SELECT status, content_digest AS digest FROM decisions WHERE decision_id = ?")
    .get(parsed.decisionId) as { status?: string; digest?: string } | undefined;
  if (!row || row.digest == null) return { error: `no decision "${parsed.decisionId}"`, code: "not_found" };

  const statement: ApprovalStatement = {
    schema: "ramp/approval-v1",
    decisionId: parsed.decisionId,
    verdict: parsed.verdict,
    factsDigest: row.digest,
    note: parsed.note ?? null,
    at: now,
  };
  const signed = signApproval(statement, demoApproverPrivateKey(parsed.approverKeyId), parsed.approverKeyId);

  try {
    return resolveEscalation(db, { approval: signed, keyring: demoApproverKeyring() });
  } catch (err) {
    if (err instanceof ApprovalError) return { error: err.message, code: err.code };
    return { error: (err as Error).message };
  }
}

/** The recorded resolution for a decision, if any (for showing history). */
export function resolutionFor(db: LedgerDb, decisionId: string): ApprovalRecord | null {
  return approvalFor(db, decisionId);
}

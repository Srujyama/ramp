/**
 * @ramp/ledger — approval.ts (resolving an escalation)
 *
 * ============================================================================
 * ESCALATION IS THEATRE UNLESS TWO THINGS ARE TRUE
 * ============================================================================
 * The kernel can say "a human must approve this" and the hook can hold the
 * payment, and none of it means anything unless:
 *
 *   1. THE AGENT CANNOT APPROVE ITSELF. If approval is something the requester
 *      can perform, escalation is a speed bump with extra steps. The agent that
 *      wanted the money asks for permission, grants it, and proceeds — and the
 *      audit trail shows a beautifully documented human-in-the-loop that never
 *      had a human in it. This is the whole ballgame, and it is why there is NO
 *      MCP TOOL that approves. The agent's tools can only ever READ a decision's
 *      approval state. Approving happens on a different channel, by a person.
 *
 *   2. APPROVAL BINDS TO THE EXACT FACTS. Approving "the escalation from
 *      agent_47" is not a thing. A human approves ONE decision, identified by
 *      its content digest. Otherwise the obvious attack: get a $1 escalation
 *      approved, then present a $50,000 payment against that approval. The
 *      approval carries the `factsDigest` it was granted against, and it is
 *      worthless for any other facts.
 *
 * Neither property is enforced by convention or by a comment. (1) is enforced by
 * there being no code path from the MCP server to this module's write functions;
 * (2) is enforced in `approvalFor` below, which refuses to return an approval
 * whose digest does not match the decision it is asked about.
 *
 * ============================================================================
 * WHAT THIS IS NOT
 * ============================================================================
 * This does not authenticate the human. `approvedBy` is a string this module
 * trusts its caller about, and in the demo that caller is a CLI anyone can run.
 * A real deployment puts an authenticated identity there (SSO, a signed approval,
 * a hardware token) and this module's shape does not change — it already treats
 * the approver as data to be recorded rather than a claim to be believed.
 *
 * Saying so matters: an approval trail that looks authoritative and is actually
 * "whoever ran the command" is exactly the kind of thing that gets mistaken for
 * a control. It is a RECORD here, not an authentication.
 */
import { sha256OfJson, type Json } from "./canonical-hash.js";
import type { LedgerDb } from "./db.js";

/** How an escalation was resolved. */
export type ApprovalVerdict = "approved" | "rejected";

/** A human's resolution of one escalated decision. */
export interface ApprovalRecord {
  readonly decisionId: string;
  readonly verdict: ApprovalVerdict;
  /**
   * Who resolved it. RECORDED, not authenticated — see the file header. In the
   * demo this is whoever ran the CLI.
   */
  readonly approvedBy: string;
  /**
   * The `content_digest` of the decision this approval was granted against.
   *
   * The binding. An approval is valid for THESE facts and no others: without it,
   * a $1 approval could be presented against a $50,000 payment.
   */
  readonly factsDigest: string;
  /** Free-text note from the approver. Recorded, never interpreted. */
  readonly note: string | null;
  readonly resolvedAt: string;
}

/** Thrown when an approval is attempted on something that cannot take one. */
export class ApprovalError extends Error {
  readonly code:
    | "not_found"
    | "not_escalated"
    | "already_resolved"
    | "self_approval";
  constructor(code: ApprovalError["code"], message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

/** Inputs for {@link resolveEscalation}. */
export interface ResolveEscalationInput {
  readonly decisionId: string;
  readonly verdict: ApprovalVerdict;
  /** The human resolving it. Must not be the requesting agent. */
  readonly approvedBy: string;
  readonly note?: string;
  /** Injected clock for deterministic tests. */
  readonly resolvedAt?: string;
}

/**
 * Resolve an escalated decision. HUMAN CHANNEL ONLY.
 *
 * There is deliberately no MCP tool that reaches this function. If you are
 * adding one, stop: the agent that requested the payment would be able to
 * approve it, and every escalation in the system becomes a formality with a
 * paper trail that lies about having had a human in it.
 *
 * Refuses to:
 *   - resolve anything that is not currently `escalated` (you cannot approve an
 *     allow, a deny, or an error — there is nothing being held);
 *   - resolve the same decision twice (approvals are not editable; a mind
 *     changed is a new decision, not a rewritten one);
 *   - let the requesting agent approve its own escalation.
 */
export function resolveEscalation(
  db: LedgerDb,
  input: ResolveEscalationInput,
): ApprovalRecord {
  const row = db
    .prepare(
      `SELECT decision_id, status, agent_id, content_digest
         FROM decisions WHERE decision_id = ?`,
    )
    .get(input.decisionId) as
    | { decision_id: string; status: string; agent_id: string; content_digest: string }
    | undefined;

  if (!row) {
    throw new ApprovalError("not_found", `no decision "${input.decisionId}"`);
  }
  if (row.status !== "escalated") {
    // Approving a deny would be the loudest possible failure: a human overriding
    // the kernel. The lattice says deny dominates; that has to be true here too,
    // or the whole ordering is decorative.
    throw new ApprovalError(
      "not_escalated",
      `decision "${input.decisionId}" is "${row.status}", not "escalated" — ` +
        `there is nothing being held. A deny is not a thing a human may approve.`,
    );
  }

  // THE CRUX. The requesting agent may not resolve its own escalation.
  //
  // Defence in depth: the primary control is that no MCP tool reaches this
  // function at all, so an agent has no way to call it. This check is the
  // backstop for the day somebody wires one up anyway, or an operator account
  // shares a name with an agent id.
  if (input.approvedBy === row.agent_id) {
    throw new ApprovalError(
      "self_approval",
      `agent "${row.agent_id}" cannot approve its own escalation. An escalation ` +
        `the requester can grant is not human review, it is a speed bump.`,
    );
  }

  const existing = db
    .prepare("SELECT verdict FROM decision_approvals WHERE decision_id = ?")
    .get(input.decisionId) as { verdict: string } | undefined;
  if (existing) {
    throw new ApprovalError(
      "already_resolved",
      `decision "${input.decisionId}" was already ${existing.verdict}. Approvals ` +
        `are append-only — a changed mind is a new decision, not a rewritten one.`,
    );
  }

  const record: ApprovalRecord = {
    decisionId: input.decisionId,
    verdict: input.verdict,
    approvedBy: input.approvedBy,
    // Bind to the decision's content digest, read from the row itself — never
    // from the caller. A caller-supplied digest would let the approver claim to
    // have approved facts they never saw.
    factsDigest: row.content_digest,
    note: input.note ?? null,
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO decision_approvals
       (decision_id, verdict, approved_by, facts_digest, note, resolved_at, approval_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.decisionId,
    record.verdict,
    record.approvedBy,
    record.factsDigest,
    record.note,
    record.resolvedAt,
    sha256OfJson(record as unknown as Json),
  );

  return record;
}

/**
 * The approval for a decision, IF it is valid for that decision's current facts.
 *
 * The binding check lives here rather than at the call site, because a call site
 * that forgets it looks exactly like one that didn't need it. If the decision's
 * `content_digest` has changed since the approval was granted, the approval is
 * NOT returned — it was granted against different facts and it is worthless for
 * these. Returning it with a caveat would just move the mistake somewhere else.
 */
export function approvalFor(db: LedgerDb, decisionId: string): ApprovalRecord | null {
  const row = db
    .prepare(
      `SELECT a.decision_id, a.verdict, a.approved_by, a.facts_digest, a.note,
              a.resolved_at, d.content_digest
         FROM decision_approvals a
         JOIN decisions d ON d.decision_id = a.decision_id
        WHERE a.decision_id = ?`,
    )
    .get(decisionId) as
    | {
        decision_id: string;
        verdict: ApprovalVerdict;
        approved_by: string;
        facts_digest: string;
        note: string | null;
        resolved_at: string;
        content_digest: string;
      }
    | undefined;

  if (!row) return null;

  // The facts moved under the approval. Whatever a human said yes to, it was not
  // this. Treat it as unapproved.
  if (row.facts_digest !== row.content_digest) return null;

  return {
    decisionId: row.decision_id,
    verdict: row.verdict,
    approvedBy: row.approved_by,
    factsDigest: row.facts_digest,
    note: row.note,
    resolvedAt: row.resolved_at,
  };
}

/**
 * May this decision be paid?
 *
 * The ONLY question the payment path should ask about an escalation. Stated
 * positively for the same reason `permitsPayment` is: a `!rejected` check would
 * treat "nobody has looked at it yet" as permission to pay, which is the exact
 * failure escalation exists to prevent.
 */
export function isApprovedForPayment(db: LedgerDb, decisionId: string): boolean {
  const approval = approvalFor(db, decisionId);
  return approval !== null && approval.verdict === "approved";
}

/** Every decision currently held, awaiting a human. Read-only. */
export function listPendingEscalations(
  db: LedgerDb,
  limit = 50,
): Array<{
  decisionId: string;
  requestId: string;
  agentId: string;
  vendorId: string;
  amount: number;
  category: string;
  ts: string;
}> {
  return db
    .prepare(
      `SELECT d.decision_id AS decisionId, d.request_id AS requestId,
              d.agent_id AS agentId, d.vendor_id AS vendorId, d.amount, d.category, d.ts
         FROM decisions d
         LEFT JOIN decision_approvals a ON a.decision_id = d.decision_id
        WHERE d.status = 'escalated' AND a.decision_id IS NULL
        ORDER BY d.ts DESC
        LIMIT ?`,
    )
    .all(limit) as never;
}

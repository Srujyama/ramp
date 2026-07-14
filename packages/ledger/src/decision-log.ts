/**
 * @ramp/ledger — decision-log.ts (the audit trail)
 *
 * Persists every policy decision the GATE makes, and reads it back for the audit
 * view. This is a PERSISTENCE layer, not a policy layer: it stores the exact
 * `Facts` and `Decision` it is handed, verbatim, and NEVER recomputes, reorders,
 * or reinterprets a policy result. `firedRules` are stored in the exact order the
 * kernel produced them.
 *
 * WHO WRITES THIS: the enforcement path — either the PreToolUse hook
 * (`.claude/hooks/evaluate.mjs`) or the self-enforcing MCP tool via
 * `requestPurchase` (`purchase.ts`). Both hold the exact Facts + Decision for a
 * request and call `recordDecision` with them verbatim; neither recomputes policy
 * here. Read-only consumers (the HTTP bridge, the verify-proof CLI) NEVER write.
 *
 * CONCURRENCY MODEL (SQLite, node:sqlite, one connection per process):
 *   - Each `recordDecision` is a single BEGIN IMMEDIATE transaction: the parent
 *     row + its fired-rule rows commit atomically, so a reader never sees a
 *     half-written decision.
 *   - `decision_id` (a UUID) is the idempotency key, but idempotency is
 *     CONTENT-CHECKED: every row stores a canonical `content_digest`. A repeat of
 *     the same `decision_id` with an IDENTICAL digest is an idempotent no-op; a
 *     repeat with a DIFFERENT digest (different request/facts/decision/proof/…) is
 *     a `DecisionConflictError` — the terminal record is NEVER overwritten. The
 *     compare happens inside the same BEGIN IMMEDIATE txn, so two conflicting
 *     concurrent inserts can never both succeed.
 *   - Distinct attempts get distinct `decision_id`s and are all recorded, even
 *     when they share a `request_id`.
 *   - An optional `LedgerProof` is persisted in the SAME transaction as its
 *     decision (atomic). A decision may have no proof; older/error rows stay
 *     readable. The proof's id is folded into `content_digest`, so a re-delivery
 *     whose proof differs is a conflict, not a silent overwrite.
 *   - WAL + busy_timeout (set in `openLedger`) let readers run during a write and
 *     make a contended writer wait rather than silently dropping an audit row; a
 *     genuine lock failure surfaces as a thrown SQLITE_BUSY, never swallowed.
 */
import { randomUUID } from "node:crypto";
import type {
  SpendRequest,
  Facts,
  Decision,
  DecisionOutcome,
  RuleId,
} from "@ramp/shared";
import { isSpendRequest } from "@ramp/shared";
import type { LedgerDb } from "./db.js";
import { sha256OfJson, type Json } from "./canonical-hash.js";
import { isLedgerProofShape, type LedgerProof } from "./proof.js";

/** Terminal persistence status of an audit row. */
export type DecisionStatus = "allowed" | "denied" | "error";

/** Default page size for {@link listDecisions} when the caller omits `limit`. */
export const DEFAULT_LIMIT = 50;
/** Hard cap on page size — a caller can never ask for more than this. */
export const MAX_LIMIT = 200;

/** Input to {@link recordDecision}. */
export interface RecordDecisionInput {
  /**
   * Idempotency key / unique attempt id. Defaults to a fresh UUID. Supply the
   * SAME id to make a repeated delivery a no-op (idempotent).
   */
  readonly decisionId?: string;
  /** The structured, untrusted spend request (stored verbatim as JSON). */
  readonly request: SpendRequest;
  /** The exact `Facts` the kernel evaluated. Omit only for a pre-facts error. */
  readonly facts?: Facts;
  /**
   * The exact `Decision` the kernel returned. Present for a real allow/deny;
   * omit (with `status: "error"`) to record an infra/validation failure.
   */
  readonly decision?: Decision;
  /**
   * Only honored when `decision` is absent: records an audit row for an
   * infrastructure/validation failure. Must be `"error"`. When `decision` is
   * present, status is derived from it and this is ignored (no mislabeling).
   */
  readonly status?: DecisionStatus;
  /** Which kernel produced the decision, e.g. `DescribedKernel.kind`. */
  readonly kernelId?: string;
  /**
   * Correlation id. Defaults to `facts.request_id` → `request.invoiceRef` →
   * `decisionId`. Not unique across attempts (by design).
   */
  readonly requestId?: string;
  /**
   * Override the stored timestamp (must be SQLite `datetime()` format, e.g.
   * `"2026-07-13 10:00:00"`). Omit to let the DB stamp `datetime('now')`.
   * Exposed mainly for deterministic tests. NOT part of `content_digest`, so a
   * re-delivery with a different `ts` but identical content is still idempotent.
   */
  readonly ts?: string;
  /**
   * Optional tamper-evident proof to persist atomically with this decision. Build
   * it with {@link buildProof}. Its `proofId` folds into the decision's
   * `content_digest`, so re-delivering the same `decisionId` with a DIFFERENT
   * proof is a {@link DecisionConflictError}.
   */
  readonly proof?: LedgerProof;
}

/**
 * Thrown when a `decision_id` is re-recorded with DIFFERENT content than the row
 * already stored. The existing (terminal) record is left untouched — this is the
 * append-only guarantee: idempotency absorbs exact replays, but a conflicting
 * replay is surfaced, never silently dropped or overwritten (no last-write-wins).
 */
export class DecisionConflictError extends Error {
  readonly decisionId: string;
  readonly existingDigest: string;
  readonly incomingDigest: string;
  constructor(decisionId: string, existingDigest: string, incomingDigest: string) {
    super(
      `recordDecision: decision_id "${decisionId}" already exists with different ` +
        `content (idempotency conflict) — refusing to overwrite the terminal record.`,
    );
    this.name = "DecisionConflictError";
    this.decisionId = decisionId;
    this.existingDigest = existingDigest;
    this.incomingDigest = incomingDigest;
  }
}

/** Result of {@link recordDecision}. */
export interface RecordDecisionResult {
  /** The decision id that was used (generated if the caller didn't supply one). */
  readonly decisionId: string;
  /** True if a new row was written; false if `decisionId` already existed (idempotent no-op). */
  readonly inserted: boolean;
}

/** One decision row read back from the audit trail. */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly requestId: string;
  readonly status: DecisionStatus;
  /** The `Decision.decision` verbatim, or `null` for an `"error"` row. */
  readonly outcome: DecisionOutcome | null;
  readonly agentId: string;
  readonly vendorId: string;
  readonly amount: number;
  readonly category: string;
  /** `true`/`false` from `Facts.attestation_present`, or `null` if facts absent. */
  readonly attestationPresent: boolean | null;
  readonly kernelId: string | null;
  /** Parsed structured request, or `null` if the stored JSON is corrupt. */
  readonly request: SpendRequest | null;
  /** Parsed facts, or `null` if absent/corrupt. */
  readonly facts: Facts | null;
  /** Parsed decision, or `null` if absent/corrupt. */
  readonly decision: Decision | null;
  /** Fired rules in stored order (from the normalized child table). */
  readonly firedRules: readonly RuleId[];
  /** The tamper-evident proof, or `null` if none was persisted for this decision. */
  readonly proof: LedgerProof | null;
  readonly ts: string;
  /**
   * `true` iff a stored JSON blob failed to parse/validate. This distinguishes
   * a CORRUPT record from a genuine denied decision (which has `corrupt: false`
   * and `outcome: "deny"`).
   */
  readonly corrupt: boolean;
}

/** Filters + pagination for {@link listDecisions}. */
export interface ListDecisionsQuery {
  readonly agentId?: string;
  readonly vendorId?: string;
  readonly outcome?: DecisionOutcome;
  readonly status?: DecisionStatus;
  /** Only rows whose firedRules include this rule id. */
  readonly firedRule?: RuleId;
  /** Inclusive lower bound on `ts` (SQLite datetime format). */
  readonly since?: string;
  /** Exclusive upper bound on `ts` (half-open range). */
  readonly until?: string;
  /** Page size; clamped to `[1, MAX_LIMIT]`, defaults to `DEFAULT_LIMIT`. */
  readonly limit?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

/** One page of decisions, newest first. */
export interface ListDecisionsResult {
  readonly decisions: readonly DecisionRecord[];
  /** Pass as `cursor` to fetch the next page; absent when the page is the last. */
  readonly nextCursor?: string;
}

// --- validation guards (persistence-boundary) --------------------------------

/** Structural guard for a `Decision` — used to reject malformed input on write. */
export function isDecisionShape(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.decision === "allow" || v.decision === "deny") &&
    Array.isArray(v.reasons) &&
    v.reasons.every((r) => typeof r === "string") &&
    Array.isArray(v.firedRules) &&
    v.firedRules.every((r) => typeof r === "string")
  );
}

/** Lightweight guard for a `Facts` blob read back from storage. */
function isFactsShape(value: unknown): value is Facts {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.request_id === "string" &&
    typeof v.amount === "number" &&
    typeof v.vendor === "string" &&
    typeof v.vendor_verified === "boolean" &&
    typeof v.daily_total_so_far === "number"
  );
}

// --- write path --------------------------------------------------------------

/**
 * Persist one policy decision atomically and idempotently.
 *
 * The parent row and its ordered fired-rule rows are written in a single
 * `BEGIN IMMEDIATE` transaction. A duplicate `decisionId` is a no-op
 * (`inserted: false`). Any DB failure ROLLS BACK and RE-THROWS — an audit row is
 * never silently dropped.
 *
 * @throws if `decision` is present but malformed, if neither a valid `decision`
 *   nor `status: "error"` is provided, or on any underlying DB error.
 */
export function recordDecision(
  db: LedgerDb,
  input: RecordDecisionInput,
): RecordDecisionResult {
  const decisionId = input.decisionId ?? randomUUID();
  const req = input.request;

  // Resolve status/outcome/firedRules from the caller's inputs WITHOUT
  // recomputing policy: if a decision is given we trust and store it verbatim.
  let status: DecisionStatus;
  let outcome: DecisionOutcome | null;
  let firedRules: readonly string[];
  if (input.decision !== undefined) {
    if (!isDecisionShape(input.decision)) {
      throw new Error(
        "recordDecision: `decision` is present but malformed — refusing to " +
          "fabricate a policy result.",
      );
    }
    outcome = input.decision.decision;
    status = outcome === "allow" ? "allowed" : "denied";
    firedRules = input.decision.firedRules;
  } else if (input.status === "error") {
    status = "error";
    outcome = null;
    firedRules = [];
  } else {
    throw new Error(
      'recordDecision: provide a valid `decision`, or `status: "error"` for an ' +
        "infrastructure failure. Refusing to invent a decision.",
    );
  }

  const requestId =
    input.requestId ??
    input.facts?.request_id ??
    req.invoiceRef ??
    decisionId;

  const attestation =
    input.facts === undefined ? null : input.facts.attestation_present ? 1 : 0;

  // Reject a malformed/mislinked proof at the persistence boundary (never store
  // a proof that doesn't belong to this decision).
  if (input.proof !== undefined) {
    if (!isLedgerProofShape(input.proof)) {
      throw new Error("recordDecision: `proof` is present but malformed.");
    }
    if (input.proof.decisionId !== decisionId) {
      throw new Error(
        `recordDecision: proof.decisionId "${input.proof.decisionId}" does not ` +
          `match decisionId "${decisionId}".`,
      );
    }
  }

  // Canonical digest of the SEMANTIC content (order-independent for object keys,
  // order-preserving for arrays). Excludes `ts` (volatile). This is the
  // idempotency/conflict key: identical content → identical digest.
  const contentDigest = sha256OfJson({
    request: req as unknown as Json,
    facts: (input.facts ?? null) as Json,
    decision: (input.decision ?? null) as Json,
    status,
    requestId,
    kernelId: input.kernelId ?? null,
    proofId: input.proof?.proofId ?? null,
  });

  const insert = db.prepare(
    `INSERT OR IGNORE INTO decisions
       (decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
        category, attestation_present, kernel_id, request_json, facts_json,
        decision_json, content_digest, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  );
  const insertRule = db.prepare(
    "INSERT INTO decision_fired_rules (decision_id, ord, rule_id) VALUES (?, ?, ?)",
  );
  const insertProof = db.prepare(
    `INSERT INTO decision_proofs
       (decision_id, proof_id, proof_schema, attestation_status, proof_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const readDigest = db.prepare(
    "SELECT content_digest FROM decisions WHERE decision_id = ?",
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    const res = insert.run(
      decisionId,
      requestId,
      status,
      outcome,
      req.requestingAgent,
      req.vendorId,
      req.amount,
      req.category,
      attestation,
      input.kernelId ?? null,
      JSON.stringify(req),
      input.facts === undefined ? null : JSON.stringify(input.facts),
      input.decision === undefined ? null : JSON.stringify(input.decision),
      contentDigest,
      input.ts ?? null,
    );
    const inserted = res.changes === 1;
    if (inserted) {
      let ord = 0;
      for (const rule of firedRules) {
        insertRule.run(decisionId, ord++, rule);
      }
      if (input.proof !== undefined) {
        insertProof.run(
          decisionId,
          input.proof.proofId,
          input.proof.schema,
          input.proof.attestationStatus,
          JSON.stringify(input.proof),
        );
      }
    } else {
      // decision_id already exists (INSERT OR IGNORE no-op). Content-check it:
      // identical digest → idempotent success; different → CONFLICT (no overwrite).
      // Reading inside this BEGIN IMMEDIATE txn (write lock held) means a racing
      // conflicting writer cannot have interleaved between our insert and read.
      const existing = readDigest.get(decisionId) as
        | { content_digest: string }
        | undefined;
      if (
        existing !== undefined &&
        existing.content_digest !== contentDigest
      ) {
        throw new DecisionConflictError(
          decisionId,
          existing.content_digest,
          contentDigest,
        );
      }
    }
    db.exec("COMMIT");
    return { decisionId, inserted };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* rollback best-effort; original error is what matters */
    }
    throw err;
  }
}

// --- read path ---------------------------------------------------------------

interface DecisionRow {
  decision_id: string;
  request_id: string;
  status: DecisionStatus;
  outcome: DecisionOutcome | null;
  agent_id: string;
  vendor_id: string;
  amount: number;
  category: string;
  attestation_present: number | null;
  kernel_id: string | null;
  request_json: string;
  facts_json: string | null;
  decision_json: string | null;
  ts: string;
}

/** Parse JSON, returning `undefined` (not throwing) on malformed input. */
function safeParse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // sentinel: corrupt
  }
}

function firedRulesFor(db: LedgerDb, decisionId: string): RuleId[] {
  const rows = db
    .prepare(
      "SELECT rule_id FROM decision_fired_rules WHERE decision_id = ? ORDER BY ord",
    )
    .all(decisionId) as Array<{ rule_id: string }>;
  return rows.map((r) => r.rule_id as RuleId);
}

/**
 * Load the (optional) proof for a decision. Returns `null` when there is no proof
 * row (normal for error/older rows), and flags `corrupt` when a stored proof blob
 * fails to parse/validate — so a tampered proof is never returned as valid.
 * Separate 1:1 lookup (not a JOIN) to leave the audited pagination SQL untouched;
 * safe because proof rows are append-only.
 */
function proofFor(
  db: LedgerDb,
  decisionId: string,
): { proof: LedgerProof | null; corrupt: boolean } {
  const row = db
    .prepare("SELECT proof_json FROM decision_proofs WHERE decision_id = ?")
    .get(decisionId) as { proof_json: string } | undefined;
  if (row === undefined) return { proof: null, corrupt: false };
  const parsed = safeParse(row.proof_json);
  const proof = isLedgerProofShape(parsed) ? parsed : null;
  return { proof, corrupt: proof === null };
}

function mapRow(db: LedgerDb, row: DecisionRow): DecisionRecord {
  const reqParsed = safeParse(row.request_json);
  const factsParsed = safeParse(row.facts_json);
  const decisionParsed = safeParse(row.decision_json);

  const request = isSpendRequest(reqParsed) ? reqParsed : null;
  const facts = isFactsShape(factsParsed) ? factsParsed : null;
  const decision = isDecisionShape(decisionParsed) ? decisionParsed : null;
  const { proof, corrupt: proofCorrupt } = proofFor(db, row.decision_id);

  // Corrupt iff a stored blob was expected but failed to parse/validate. A NULL
  // facts_json/decision_json (legitimately absent) is NOT corrupt; an absent proof
  // is NOT corrupt (proof is optional), but a present-yet-unparseable proof IS.
  const corrupt =
    request === null ||
    (row.facts_json !== null && facts === null) ||
    (row.decision_json !== null && decision === null) ||
    proofCorrupt;

  return {
    decisionId: row.decision_id,
    requestId: row.request_id,
    status: row.status,
    outcome: row.outcome,
    agentId: row.agent_id,
    vendorId: row.vendor_id,
    amount: Number(row.amount),
    category: row.category,
    attestationPresent:
      row.attestation_present === null ? null : row.attestation_present === 1,
    kernelId: row.kernel_id,
    request,
    facts,
    decision,
    firedRules: firedRulesFor(db, row.decision_id),
    proof,
    ts: row.ts,
    corrupt,
  };
}

/** Fetch a single decision by id, or `undefined` if there is none. */
export function getDecision(
  db: LedgerDb,
  decisionId: string,
): DecisionRecord | undefined {
  const row = db
    .prepare(
      `SELECT decision_id, request_id, status, outcome, agent_id, vendor_id,
              amount, category, attestation_present, kernel_id, request_json,
              facts_json, decision_json, ts
         FROM decisions WHERE decision_id = ?`,
    )
    .get(decisionId) as DecisionRow | undefined;
  return row ? mapRow(db, row) : undefined;
}

interface Cursor {
  readonly ts: string;
  readonly decisionId: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("listDecisions: malformed cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Cursor).ts !== "string" ||
    typeof (parsed as Cursor).decisionId !== "string"
  ) {
    throw new Error("listDecisions: malformed cursor");
  }
  return { ts: (parsed as Cursor).ts, decisionId: (parsed as Cursor).decisionId };
}

/**
 * List decisions, NEWEST FIRST, with keyset pagination.
 *
 * Ordering is the deterministic compound key `(ts DESC, decision_id DESC)`; the
 * unique `decision_id` breaks ties between rows that share a (second-resolution)
 * timestamp, so pagination never skips or duplicates a row even when many
 * decisions land in the same second. New inserts between page fetches only ever
 * appear on earlier pages, never disturbing rows already walked.
 *
 * @throws on a malformed `cursor`.
 */
export function listDecisions(
  db: LedgerDb,
  query: ListDecisionsQuery = {},
): ListDecisionsResult {
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.agentId !== undefined) {
    where.push("agent_id = ?");
    params.push(query.agentId);
  }
  if (query.vendorId !== undefined) {
    where.push("vendor_id = ?");
    params.push(query.vendorId);
  }
  if (query.outcome !== undefined) {
    where.push("outcome = ?");
    params.push(query.outcome);
  }
  if (query.status !== undefined) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.since !== undefined) {
    where.push("ts >= ?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    where.push("ts < ?");
    params.push(query.until);
  }
  if (query.firedRule !== undefined) {
    where.push(
      "EXISTS (SELECT 1 FROM decision_fired_rules r " +
        "WHERE r.decision_id = decisions.decision_id AND r.rule_id = ?)",
    );
    params.push(query.firedRule);
  }
  if (query.cursor !== undefined) {
    const c = decodeCursor(query.cursor);
    // Strict keyset: everything ordered after the cursor row in (ts, id) DESC.
    where.push("(ts < ? OR (ts = ? AND decision_id < ?))");
    params.push(c.ts, c.ts, c.decisionId);
  }

  const sql =
    `SELECT decision_id, request_id, status, outcome, agent_id, vendor_id,
            amount, category, attestation_present, kernel_id, request_json,
            facts_json, decision_json, ts
       FROM decisions` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ts DESC, decision_id DESC LIMIT ?`;

  // Fetch one extra row to know whether a further page exists.
  const rows = db.prepare(sql).all(...params, limit + 1) as unknown as DecisionRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const decisions = page.map((r) => mapRow(db, r));

  const last = page[page.length - 1];
  if (hasMore && last !== undefined) {
    return {
      decisions,
      nextCursor: encodeCursor({ ts: last.ts, decisionId: last.decision_id }),
    };
  }
  return { decisions };
}

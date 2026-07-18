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
import { nextLink } from "./chain.js";
import { sha256OfJson, type Json } from "./canonical-hash.js";
import { isLedgerProofShape, type LedgerProof } from "./proof.js";

/** Terminal persistence status of an audit row. */
/**
 * Terminal persistence status.
 *   - `escalated` — policy could not settle it; a human must. HELD, never paid.
 *   - `error`     — an infra/validation failure recorded as an audit row, NOT a
 *                   policy outcome and never one of the policy rules.
 */
export type DecisionStatus = "allowed" | "denied" | "escalated" | "error";

/** Terminal status of a recorded sandbox execution. */
export type ExecutionStatus = "settled" | "failed";

/**
 * A sandbox execution receipt read back from the audit trail. Records what the
 * executor DID after an allowed+verified decision — never carries a secret.
 */
export interface ExecutionRecord {
  readonly receiptId: string;
  readonly executionId: string;
  readonly status: ExecutionStatus;
  /** e.g. "sandbox". */
  readonly provider: string;
  readonly executedAt: string;
}

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
  /**
   * The sandbox execution receipt, or `null` if the executor never ran for this
   * decision (every deny, and any allow that failed before execution). A row with
   * `status: "failed"` is a genuine executor failure — NOT a settlement.
   */
  readonly execution: ExecutionRecord | null;
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
    (v.decision === "allow" || v.decision === "deny" || v.decision === "escalate") &&
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
    // Map the kernel's verdict onto a persistence status. Exhaustive on purpose:
    // a ternary here would have silently recorded an ESCALATED decision as
    // "denied" — a held payment filed as a refused one, which is a different
    // event, and the audit trail would say the wrong thing forever.
    status =
      outcome === "allow" ? "allowed" : outcome === "escalate" ? "escalated" : "denied";
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
        decision_json, content_digest, seq, prev_chain_hash, chain_hash, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
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
    // The chain link is computed HERE, inside BEGIN IMMEDIATE, on purpose. The
    // write lock is already held, so `nextLink`'s read of the current head cannot
    // interleave with a racing writer's. Computing it before the transaction
    // would let two concurrent writers read the same head, claim the same `seq`,
    // and fork the chain — which the unique index on `seq` would then surface as
    // a crash rather than a fork, but only after one of them had already been
    // told its decision was recorded.
    const link = nextLink(db, decisionId, input.proof?.proofId ?? null);

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
      link.seq,
      link.prevChainHash,
      link.chainHash,
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

/** Input to {@link recordExecution}. */
export interface RecordExecutionInput {
  /** The decision this execution belongs to (must already be recorded). */
  readonly decisionId: string;
  readonly receiptId: string;
  readonly executionId: string;
  readonly status: ExecutionStatus;
  /** e.g. "sandbox". */
  readonly provider: string;
  /** Override the stored timestamp (SQLite datetime format). Tests only. */
  readonly executedAt?: string;
}

/**
 * Persist ONE sandbox execution receipt for an already-recorded decision.
 *
 * This is a SEPARATE, LATER append from {@link recordDecision} — execution is a
 * genuinely subsequent event, so it is never folded into the decision's
 * transaction and can never alter the append-only decision/proof record. The
 * executor is deterministic, so `decision_id` is the idempotency key: a repeat
 * is an `INSERT OR IGNORE` no-op (`inserted: false`), never an overwrite.
 *
 * Callers should treat a failure here as non-fatal to the payment result — the
 * money-movement decision is already durably recorded; a missing execution row
 * only means the receipt isn't shown in the audit view.
 *
 * @returns `{ inserted }` — false if an execution row already existed.
 */
export function recordExecution(
  db: LedgerDb,
  input: RecordExecutionInput,
): { inserted: boolean } {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO decision_executions
         (decision_id, receipt_id, execution_id, status, provider, executed_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(
      input.decisionId,
      input.receiptId,
      input.executionId,
      input.status,
      input.provider,
      input.executedAt ?? null,
    );
  const inserted = res.changes === 1;

  // A SETTLED execution is the moment spend actually moves — so this is where a
  // `ledger_entries` row is born, projected from the decision's own recorded
  // fields. `daily_total_so_far`, the velocity count, the duplicate check, and the
  // windowed budgets all read `ledger_entries`, and NOTHING wrote it: only the seed
  // ever inserted rows, so those totals were frozen at seed data and D5 was, in
  // practice, unenforceable. This is that missing writer.
  //
  // Guarded on `inserted` so it fires exactly once per execution — a replayed
  // receipt (INSERT OR IGNORE no-op) adds no spend, keeping this idempotent. Only
  // `settled` counts: a `failed` receipt is a real, auditable executor outcome but
  // no money moved, so it must never become spend. Reads the decision by id and
  // requires `outcome='allow'`, so a settled row for a non-allow (which the
  // lifecycle already forbids) still cannot inflate a total it should not.
  if (inserted && input.status === "settled") {
    const d = db
      .prepare(
        `SELECT agent_id, vendor_id, category, amount, request_id
           FROM decisions WHERE decision_id = ? AND outcome = 'allow'`,
      )
      .get(input.decisionId) as
      | { agent_id: string; vendor_id: string; category: string; amount: number; request_id: string }
      | undefined;
    if (d) {
      // `ts` mirrors the execution time, not now: a backfilled/settled-in-the-past
      // receipt must land on the day it settled, or "spent today" counts a payment
      // that did not happen today. Currency defaults to USD in the schema (money is
      // whole-unit USD everywhere), so it is intentionally omitted here.
      db.prepare(
        `INSERT INTO ledger_entries (agent_id, vendor_id, category_id, amount, request_id, ts)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      ).run(d.agent_id, d.vendor_id, d.category, d.amount, d.request_id, input.executedAt ?? null);
    }
  }

  return { inserted };
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

/**
 * Load the (optional) sandbox execution receipt for a decision. Returns `null`
 * when the executor never ran (every deny; any allow that failed pre-execution).
 * Discrete columns (no JSON blob) → no parse-corruption path. Separate 1:1 lookup
 * (not a JOIN), mirroring {@link proofFor}, to leave the paginated SQL untouched.
 */
function executionFor(db: LedgerDb, decisionId: string): ExecutionRecord | null {
  const row = db
    .prepare(
      `SELECT receipt_id, execution_id, status, provider, executed_at
         FROM decision_executions WHERE decision_id = ?`,
    )
    .get(decisionId) as
    | {
        receipt_id: string;
        execution_id: string;
        status: ExecutionStatus;
        provider: string;
        executed_at: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    receiptId: row.receipt_id,
    executionId: row.execution_id,
    status: row.status,
    provider: row.provider,
    executedAt: row.executed_at,
  };
}

function mapRow(db: LedgerDb, row: DecisionRow): DecisionRecord {
  const reqParsed = safeParse(row.request_json);
  const factsParsed = safeParse(row.facts_json);
  const decisionParsed = safeParse(row.decision_json);

  const request = isSpendRequest(reqParsed) ? reqParsed : null;
  const facts = isFactsShape(factsParsed) ? factsParsed : null;
  const decision = isDecisionShape(decisionParsed) ? decisionParsed : null;
  const { proof, corrupt: proofCorrupt } = proofFor(db, row.decision_id);
  const execution = executionFor(db, row.decision_id);

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
    execution,
    ts: row.ts,
    corrupt,
  };
}

/** One decision plus its monotonic chain `seq` — for tailing the log in order. */
export interface SeqDecision {
  readonly seq: number;
  readonly record: DecisionRecord;
}

/** The highest `seq` currently in the log (0 if empty) — the live tail position. */
export function latestDecisionSeq(db: LedgerDb): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM decisions").get() as {
    head: number;
  };
  return Number(row.head);
}

/**
 * Decisions with `seq > sinceSeq`, OLDEST FIRST, capped at `limit`. This is the
 * READ-ONLY tail the real-time SSE feed polls: the append-only log only ever grows,
 * and `seq` is the monotonic, unique, indexed chain position (idx_decisions_seq),
 * so walking `seq > lastSeen` never skips or repeats a row even under concurrent
 * appends — unlike a second-resolution `ts` cursor. Each row carries its `seq` so a
 * client can resume exactly where it left off (SSE `Last-Event-ID`).
 */
export function tailDecisions(
  db: LedgerDb,
  sinceSeq: number,
  limit = 200,
): SeqDecision[] {
  const rows = db
    .prepare(
      `SELECT seq, decision_id, request_id, status, outcome, agent_id, vendor_id,
              amount, category, attestation_present, kernel_id, request_json,
              facts_json, decision_json, ts
         FROM decisions WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(sinceSeq, limit) as unknown as Array<DecisionRow & { seq: number }>;
  return rows.map((r) => ({ seq: Number(r.seq), record: mapRow(db, r) }));
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

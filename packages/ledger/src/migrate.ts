/**
 * @ramp/ledger — migrate.ts (CHECK-constraint migrations)
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `applySchema` heals missing TABLES (`CREATE TABLE IF NOT EXISTS`) and
 * `healColumns` heals missing COLUMNS (`ALTER TABLE ... ADD COLUMN`). Neither can
 * touch a CHECK constraint: SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, and
 * a CHECK is baked into the table's stored DDL.
 *
 * That matters the moment policy grows a new outcome. `decisions` was created with
 *
 *     status  TEXT NOT NULL CHECK (status IN ('allowed','denied','error'))
 *     outcome TEXT          CHECK (outcome IN ('allow','deny'))
 *
 * so a pre-existing ledger REJECTS an escalated decision outright:
 *
 *     Error: CHECK constraint failed: status IN ('allowed','denied','error')
 *
 * Verified against the real DB before this file was written. The failure is
 * fail-closed by luck rather than design — recordDecision throws, the hook's
 * audit write fails, and the hook denies. Safe, but wrong: policy said "ask a
 * human" and the agent is told "denied". The whole point of the third outcome
 * evaporates on any ledger that predates it.
 *
 * ============================================================================
 * THE FOOTGUN: THIS MIGRATION CAN DELETE THE AUDIT TRAIL
 * ============================================================================
 * Changing a CHECK means rebuilding the table: create a new one, copy the rows,
 * drop the old, rename. But `decision_proofs` and `decision_fired_rules` declare
 *
 *     REFERENCES decisions(decision_id) ON DELETE CASCADE
 *
 * so `DROP TABLE decisions` with foreign keys ON **cascades into them and erases
 * every proof and every fired rule** — silently, inside a migration nobody was
 * watching, in the exact table whose entire purpose is being tamper-evident.
 *
 * Hence `PRAGMA foreign_keys = OFF` around the swap (SQLite's documented 12-step
 * ALTER procedure), a `foreign_key_check` before committing, and a row-count
 * assertion that refuses to commit if anything was lost. If this file is ever
 * edited, that ordering is the part to get right.
 */
import type { LedgerDb } from "./db.js";

/** The DDL for the rebuilt `decisions` table, with the widened CHECKs. */
const DECISIONS_TABLE_V2 = `
CREATE TABLE decisions_v2 (
  decision_id         TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('allowed', 'denied', 'escalated', 'error')),
  outcome             TEXT CHECK (outcome IN ('allow', 'deny', 'escalate')),
  agent_id            TEXT NOT NULL,
  vendor_id           TEXT NOT NULL,
  amount              INTEGER NOT NULL,
  category            TEXT NOT NULL,
  attestation_present INTEGER CHECK (attestation_present IN (0, 1)),
  kernel_id           TEXT,
  request_json        TEXT NOT NULL,
  facts_json          TEXT,
  decision_json       TEXT,
  content_digest      TEXT NOT NULL,
  seq                 INTEGER,
  prev_chain_hash     TEXT,
  chain_hash          TEXT,
  ts                  TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * True iff `decisions` already accepts the `escalate` outcome.
 *
 * Read from `sqlite_master`'s stored DDL rather than by trial-inserting and
 * rolling back: a probe write inside a migration is a great way to leave a
 * half-committed row in an audit table if anything goes wrong mid-way.
 */
function acceptsEscalate(db: LedgerDb): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='decisions'")
    .get() as { sql: string } | undefined;
  if (!row) return true; // no table yet — CREATE TABLE will make it correct.
  return row.sql.includes("'escalate'");
}

/**
 * Rebuild `decisions` with the widened CHECK constraints, preserving every row
 * and every dependent proof.
 *
 * Idempotent: a no-op once the table already accepts `escalate`.
 *
 * @throws if any row would be lost. Refusing to migrate is strictly better than
 *   silently shortening an audit trail — a migration that eats history is
 *   indistinguishable from the tampering the chain exists to detect.
 */
export function migrateDecisionsChecks(db: LedgerDb): boolean {
  if (acceptsEscalate(db)) return false;

  const before = (
    db.prepare("SELECT count(*) AS n FROM decisions").get() as { n: number }
  ).n;
  const proofsBefore = (
    db.prepare("SELECT count(*) AS n FROM decision_proofs").get() as { n: number }
  ).n;
  const rulesBefore = (
    db.prepare("SELECT count(*) AS n FROM decision_fired_rules").get() as { n: number }
  ).n;

  // FOREIGN KEYS OFF FIRST. Not a formality — see the header. With them on, the
  // DROP below cascades into decision_proofs and decision_fired_rules and erases
  // the entire proof history. This pragma is a no-op inside a transaction, so it
  // MUST come before BEGIN.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(DECISIONS_TABLE_V2);
    db.exec(`
      INSERT INTO decisions_v2
        (decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
         category, attestation_present, kernel_id, request_json, facts_json,
         decision_json, content_digest, seq, prev_chain_hash, chain_hash, ts)
      SELECT
         decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
         category, attestation_present, kernel_id, request_json, facts_json,
         decision_json, content_digest, seq, prev_chain_hash, chain_hash, ts
        FROM decisions
    `);

    const copied = (
      db.prepare("SELECT count(*) AS n FROM decisions_v2").get() as { n: number }
    ).n;
    if (copied !== before) {
      throw new Error(
        `migration would lose decisions: ${before} before, ${copied} copied. ` +
          `Refusing — a migration that shortens an audit trail is indistinguishable ` +
          `from the tampering the chain exists to detect.`,
      );
    }

    db.exec("DROP TABLE decisions");
    db.exec("ALTER TABLE decisions_v2 RENAME TO decisions");
    // The index went with the old table.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_seq ON decisions (seq) WHERE seq IS NOT NULL",
    );

    // The dependent rows must have survived the drop. If foreign_keys were ON,
    // these are now zero and this is where we find out.
    const proofsAfter = (
      db.prepare("SELECT count(*) AS n FROM decision_proofs").get() as { n: number }
    ).n;
    const rulesAfter = (
      db.prepare("SELECT count(*) AS n FROM decision_fired_rules").get() as { n: number }
    ).n;
    if (proofsAfter !== proofsBefore || rulesAfter !== rulesBefore) {
      throw new Error(
        `migration cascaded into dependent rows: proofs ${proofsBefore}->${proofsAfter}, ` +
          `rules ${rulesBefore}->${rulesAfter}. Rolling back.`,
      );
    }

    const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (violations.length > 0) {
      throw new Error(`migration left ${violations.length} foreign key violation(s); rolling back`);
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the throw below is what matters */
    }
    throw err;
  } finally {
    // Restore the invariant the rest of the process relies on, whether we
    // committed or rolled back.
    db.exec("PRAGMA foreign_keys = ON");
  }

  return true;
}

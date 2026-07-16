/**
 * @ramp/ledger — db.ts
 *
 * Opens the authoritative SQLite fact store using Node 24's BUILT-IN
 * `node:sqlite` (`DatabaseSync`) — no native `better-sqlite3` build step, no
 * npm dependency. On Node 24 `node:sqlite` is available; on some 22.x lines it
 * requires the `--experimental-sqlite` flag. If the import throws, we surface a
 * clear, actionable error rather than silently degrading.
 *
 * The DB is the ONLY source of the security-critical facts. This module just
 * opens/creates it; `dal.ts` does the authoritative reads. If the target DB file
 * does not yet exist (or is an empty, un-provisioned DB), we provision it from
 * `sql/schema.sql` + `sql/seed.sql` so a fresh checkout "just works".
 */
import { DatabaseSync } from "node:sqlite";
import { migrateDecisionsChecks } from "./migrate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** A minimal structural view of the `node:sqlite` DatabaseSync we depend on. */
export type LedgerDb = DatabaseSync;

/** In-memory sentinel path — a throwaway DB that lives only for the process. */
export const IN_MEMORY_PATH = ":memory:";

/** How long a contended writer waits for the lock before surfacing SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

// Resolve the packaged SQL files relative to THIS module, so it works no matter
// the process cwd. Compiled layout: dist/src/db.js -> package root is ../../ ->
// the `sql/` dir ships alongside `dist/` (see package.json "files").
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const SQL_DIR = join(PKG_ROOT, "sql");

/**
 * Default on-disk DB path: `ramp.db` at the LEDGER PACKAGE ROOT, as an ABSOLUTE
 * path anchored to this module — deliberately NOT cwd-relative.
 *
 * ============================================================================
 * WHY THIS IS ABSOLUTE (a fail-OPEN bug lived here).
 * ============================================================================
 * This was once the bare relative string `"ramp.db"`, which resolves against
 * `process.cwd()` — so it named a DIFFERENT FILE depending on who called it:
 *   - `pnpm db:reset` runs with cwd `packages/ledger/` -> seeded packages/ledger/ramp.db
 *   - the PreToolUse hook runs with cwd `$CLAUDE_PROJECT_DIR` -> opened ./ramp.db
 * The hook therefore read an entirely different (stale, empty) ledger than the
 * one the seed provisioned. Because `daily_total_so_far` sums to 0 on an empty
 * ledger, the gate reported "daily 0 + 400 <= 1500" and ALLOWED a spend that
 * must deny. A misresolved ledger has to fail CLOSED; instead it silently
 * granted the agent a fresh daily budget.
 *
 * Anchoring to `import.meta.url` makes the path a property of the INSTALLATION,
 * not of whoever happens to spawn the process. Override with `$RAMP_DB_PATH`.
 */
export const DEFAULT_DB_PATH = join(PKG_ROOT, "ramp.db");

/**
 * Resolve the ledger DB path. Precedence: explicit argument > `$RAMP_DB_PATH` >
 * {@link DEFAULT_DB_PATH}. Every filesystem result is absolute — a relative path
 * is resolved against cwd ONCE, here, and never re-interpreted downstream.
 * The `:memory:` sentinel is passed through untouched.
 */
export function resolveDbPath(path?: string): string {
  const candidate = path ?? process.env.RAMP_DB_PATH;
  if (candidate === undefined) return DEFAULT_DB_PATH;
  if (candidate === IN_MEMORY_PATH) return IN_MEMORY_PATH;
  return resolve(candidate);
}

/**
 * Thrown when a ledger is opened but is not provisioned (no `policy_limits`
 * row). Callers on the enforcement path MUST let this propagate into a deny —
 * an unprovisioned fact store is indistinguishable from "no spend today", which
 * is exactly the fail-open we refuse to ship.
 */
export class LedgerNotProvisionedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `@ramp/ledger: the ledger at "${path}" is not provisioned (no policy_limits row). ` +
        `Refusing to serve facts from an empty fact store — run \`pnpm db:reset\`. ` +
        `(An unprovisioned ledger reports daily_total_so_far = 0, which would fail OPEN.)`,
    );
    this.name = "LedgerNotProvisionedError";
    this.path = path;
  }
}

/** Absolute path to the DDL script. */
export const SCHEMA_SQL_PATH = join(SQL_DIR, "schema.sql");
/** Absolute path to the demo seed script. */
export const SEED_SQL_PATH = join(SQL_DIR, "seed.sql");

/** Read the schema DDL text from disk. */
export function readSchemaSql(): string {
  return readFileSync(SCHEMA_SQL_PATH, "utf8");
}

/** Read the demo seed text from disk. */
export function readSeedSql(): string {
  return readFileSync(SEED_SQL_PATH, "utf8");
}

/** Options for {@link openLedger}. */
export interface OpenLedgerOptions {
  /**
   * If true, apply schema + seed when the DB has no `policy_limits` row yet
   * (i.e. it is brand-new / un-provisioned). Defaults to true so a fresh file or
   * `:memory:` DB comes up fully seeded. Set false to open strictly read-as-is.
   *
   * SECURITY: the ENFORCEMENT path must pass `false` (see {@link openLedgerStrict}).
   * Auto-provisioning is a developer convenience that, on a mistyped or
   * misresolved path, silently conjures a brand-new seeded ledger — one that
   * reports zero spend today and therefore ALLOWS. Convenience here, never on
   * the path where money moves.
   */
  readonly provisionIfEmpty?: boolean;
  /** If true, also (re)apply the seed even when provisioning. Defaults to true. */
  readonly seed?: boolean;
  /**
   * If true, throw {@link LedgerNotProvisionedError} when the opened DB has no
   * `policy_limits` row. Use on the enforcement path so an empty/missing fact
   * store becomes a DENY instead of a permissive default. Defaults to false.
   */
  readonly requireProvisioned?: boolean;
}

/**
 * True iff the DB is already provisioned (has the `policy_limits` singleton row).
 * Used to decide whether a freshly-opened DB needs schema+seed applied.
 */
export function isProvisioned(db: LedgerDb): boolean {
  try {
    const row = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'policy_limits'",
      )
      .get() as { n: number } | undefined;
    if (!row || row.n === 0) return false;
    const lim = db.prepare("SELECT count(*) AS n FROM policy_limits").get() as
      | { n: number }
      | undefined;
    return !!lim && lim.n > 0;
  } catch {
    return false;
  }
}

/**
 * Additive COLUMN migrations, keyed by table.
 *
 * `CREATE TABLE IF NOT EXISTS` heals a missing TABLE on a pre-existing DB, which
 * is what `applySchema` relies on — but it does nothing for a missing COLUMN on
 * a table that already exists. So a ledger created before the hash chain landed
 * would keep working right up until the first `SELECT chain_hash`, then fail with
 * "no such column" at read time, i.e. in the dashboard, in front of someone.
 *
 * Every entry here must be genuinely additive and nullable. A column added with a
 * non-null default would silently fabricate history for rows written before the
 * column existed — and for the chain columns specifically, inventing a plausible
 * link is exactly the lie the chain is meant to detect. Old rows get NULL,
 * `verifyChain` skips them, and the audit output says so.
 */
const ADDITIVE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  { table: "decisions", column: "seq", ddl: "ALTER TABLE decisions ADD COLUMN seq INTEGER" },
  // Escalation. Both carry defaults chosen so a migrated ledger behaves EXACTLY
  // as it did before escalation existed: a threshold equal to "effectively
  // infinite" escalates nothing, and 'standard' is not an elevated tier. A
  // migration must never invent policy — the operator sets these deliberately.
  {
    table: "policy_limits",
    column: "escalation_threshold",
    ddl: "ALTER TABLE policy_limits ADD COLUMN escalation_threshold INTEGER NOT NULL DEFAULT 2147483647",
  },
  {
    table: "vendors",
    column: "risk_tier",
    ddl: "ALTER TABLE vendors ADD COLUMN risk_tier TEXT NOT NULL DEFAULT 'standard'",
  },
  {
    table: "decisions",
    column: "prev_chain_hash",
    ddl: "ALTER TABLE decisions ADD COLUMN prev_chain_hash TEXT",
  },
  {
    table: "decisions",
    column: "chain_hash",
    ddl: "ALTER TABLE decisions ADD COLUMN chain_hash TEXT",
  },
];

/** True iff `table` exists and has `column`. Never throws. */
function hasColumn(db: LedgerDb, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** Add any missing additive columns. Idempotent; safe on a fresh DB. */
export function healColumns(db: LedgerDb): void {
  for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
    // The table itself may not exist yet on a truly fresh DB — applySchema's
    // CREATE TABLE covers that, and this loop then finds the column present.
    const tableExists = (
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { n: number }
    ).n > 0;
    if (!tableExists) continue;
    if (hasColumn(db, table, column)) continue;
    db.exec(ddl);
  }
}

/**
 * Apply the schema DDL (idempotent — every statement is `IF NOT EXISTS`), then
 * heal any additive columns the DDL cannot add to an existing table.
 *
 * `healColumns` MUST run before `readSchemaSql`'s DDL, not after: schema.sql
 * also declares `idx_decisions_seq`, an index ON the additive `seq` column, in
 * the SAME statement batch as `CREATE TABLE IF NOT EXISTS decisions`. On a
 * pre-existing ledger from before `seq` existed, `CREATE TABLE IF NOT EXISTS`
 * is a no-op (table already there) but the index creation still runs against
 * that old table — "no such column: seq" — before `healColumns` ever gets a
 * chance to add it. Healing first means the column already exists by the time
 * the index statement runs, on both a fresh DB (table doesn't exist yet, so
 * this loop no-ops via the tableExists check) and an old one (column gets
 * added here).
 */
export function applySchema(db: LedgerDb): void {
  healColumns(db);
  db.exec(readSchemaSql());
  // CHECK constraints cannot be ALTERed in SQLite, so widening one means
  // rebuilding the table. See migrate.ts — it is the only migration here that
  // can destroy data if it is edited carelessly.
  migrateDecisionsChecks(db);
}

/** Apply the demo seed. Assumes a fresh schema (inserts are not idempotent). */
export function applySeed(db: LedgerDb): void {
  db.exec(readSeedSql());
}

/**
 * Open the ledger DB. Creates the file if missing (DatabaseSync does this),
 * enforces `foreign_keys`, and — unless disabled — provisions schema+seed when
 * the DB is not yet set up. Returns the live `DatabaseSync` handle.
 */
export function openLedger(
  path?: string,
  opts: OpenLedgerOptions = {},
): LedgerDb {
  const provisionIfEmpty = opts.provisionIfEmpty ?? true;
  const seed = opts.seed ?? true;
  const requireProvisioned = opts.requireProvisioned ?? false;
  const target = resolveDbPath(path);

  let db: LedgerDb;
  try {
    db = new DatabaseSync(target);
  } catch (err) {
    throw new Error(
      `@ramp/ledger: failed to open SQLite DB at "${target}" via node:sqlite. ` +
        `On Node 24 node:sqlite is built in; on Node 22 it needs --experimental-sqlite. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  // Always enforce referential integrity on this connection.
  db.exec("PRAGMA foreign_keys = ON;");

  // Concurrency: the audit log has many writers (one hook process per spend) and
  // concurrent readers (the dashboard). A bounded busy_timeout makes a contended
  // writer WAIT for the lock instead of failing instantly with SQLITE_BUSY, and
  // WAL lets readers see a consistent snapshot while a writer commits. WAL only
  // applies to on-disk DBs; a :memory: DB is single-connection and ignores it.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  if (path !== IN_MEMORY_PATH) {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  if (provisionIfEmpty) {
    // `applySchema` is idempotent (every statement is `IF NOT EXISTS`), so running
    // it on every writable open HEALS additive schema changes on a pre-existing DB
    // — e.g. a ledger created before `decision_executions` existed gets the new
    // table now, instead of the bridge 500-ing with "no such table" when it's read.
    // Seed ONLY a genuinely fresh DB (inserts are not idempotent — never re-seed).
    const fresh = !isProvisioned(db);
    applySchema(db);
    if (fresh && seed) applySeed(db);
  }

  if (requireProvisioned && !isProvisioned(db)) {
    closeLedger(db);
    throw new LedgerNotProvisionedError(target);
  }

  return db;
}

/**
 * Open the ledger for ENFORCEMENT: never provision, and throw
 * {@link LedgerNotProvisionedError} unless the fact store is already populated.
 *
 * This is the constructor the PreToolUse hook uses. It exists so the difference
 * between "the agent has spent nothing today" and "I am reading the wrong/empty
 * database" can never collapse into the same answer — the first is a fact, the
 * second is a failure, and a failure must deny.
 */
export function openLedgerStrict(path?: string): LedgerDb {
  return openLedger(path, {
    provisionIfEmpty: false,
    seed: false,
    requireProvisioned: true,
  });
}

/** Close a ledger DB handle. Safe to call once; ignores double-close. */
export function closeLedger(db: LedgerDb): void {
  try {
    db.close();
  } catch {
    /* already closed — ignore */
  }
}

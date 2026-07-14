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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A minimal structural view of the `node:sqlite` DatabaseSync we depend on. */
export type LedgerDb = DatabaseSync;

/** Default on-disk DB path for local dev (`./ramp.db` at the ledger package root). */
export const DEFAULT_DB_PATH = "ramp.db";

/** In-memory sentinel path — a throwaway DB that lives only for the process. */
export const IN_MEMORY_PATH = ":memory:";

// Resolve the packaged SQL files relative to THIS module, so it works no matter
// the process cwd. Compiled layout: dist/src/db.js -> package root is ../../ ->
// the `sql/` dir ships alongside `dist/` (see package.json "files").
const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, "..", "..", "sql");

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
   */
  readonly provisionIfEmpty?: boolean;
  /** If true, also (re)apply the seed even when provisioning. Defaults to true. */
  readonly seed?: boolean;
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

/** Apply the schema DDL (idempotent — every statement is `IF NOT EXISTS`). */
export function applySchema(db: LedgerDb): void {
  db.exec(readSchemaSql());
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
  path: string = DEFAULT_DB_PATH,
  opts: OpenLedgerOptions = {},
): LedgerDb {
  const provisionIfEmpty = opts.provisionIfEmpty ?? true;
  const seed = opts.seed ?? true;

  let db: LedgerDb;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw new Error(
      `@ramp/ledger: failed to open SQLite DB at "${path}" via node:sqlite. ` +
        `On Node 24 node:sqlite is built in; on Node 22 it needs --experimental-sqlite. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  // Always enforce referential integrity on this connection.
  db.exec("PRAGMA foreign_keys = ON;");

  if (provisionIfEmpty && !isProvisioned(db)) {
    applySchema(db);
    if (seed) applySeed(db);
  }

  return db;
}

/** Close a ledger DB handle. Safe to call once; ignores double-close. */
export function closeLedger(db: LedgerDb): void {
  try {
    db.close();
  } catch {
    /* already closed — ignore */
  }
}

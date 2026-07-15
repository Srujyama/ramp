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
import { dirname, join, resolve } from "node:path";

/** A minimal structural view of the `node:sqlite` DatabaseSync we depend on. */
export type LedgerDb = DatabaseSync;

/** In-memory sentinel path — a throwaway DB that lives only for the process. */
export const IN_MEMORY_PATH = ":memory:";

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

  if (provisionIfEmpty && !isProvisioned(db)) {
    applySchema(db);
    if (seed) applySeed(db);
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

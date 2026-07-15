/**
 * @ramp/ledger — barrel
 *
 * The AUTHORITATIVE fact source for Provable Agent Spend. Everything the hook
 * needs to turn an untrusted `SpendRequest` into ground-truth facts is here:
 *   - `openLedger` / `closeLedger` — open the SQLite fact store (node:sqlite).
 *   - `LedgerFactSource` — the anti-injection DAL (`contextFor`, plus the
 *     granular authoritative reads).
 *
 * These are pure DB reads; they NEVER trust the model's narration.
 */
export {
  openLedger,
  openLedgerStrict,
  closeLedger,
  isProvisioned,
  applySchema,
  applySeed,
  readSchemaSql,
  readSeedSql,
  resolveDbPath,
  LedgerNotProvisionedError,
  DEFAULT_DB_PATH,
  IN_MEMORY_PATH,
  SCHEMA_SQL_PATH,
  SEED_SQL_PATH,
} from "./db.js";
export type { LedgerDb, OpenLedgerOptions } from "./db.js";

export { LedgerFactSource, makeFactSource, UnknownAgentError } from "./dal.js";
export type { Limits } from "./dal.js";

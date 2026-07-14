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
  closeLedger,
  isProvisioned,
  applySchema,
  applySeed,
  readSchemaSql,
  readSeedSql,
  DEFAULT_DB_PATH,
  IN_MEMORY_PATH,
  SCHEMA_SQL_PATH,
  SEED_SQL_PATH,
} from "./db.js";
export type { LedgerDb, OpenLedgerOptions } from "./db.js";

export { LedgerFactSource, makeFactSource } from "./dal.js";
export type { AuthoritativeContext, Limits } from "./dal.js";

// The audit trail: persist every gate decision and read it back (read-only API).
export {
  recordDecision,
  getDecision,
  listDecisions,
  isDecisionShape,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "./decision-log.js";
export type {
  DecisionStatus,
  RecordDecisionInput,
  RecordDecisionResult,
  DecisionRecord,
  ListDecisionsQuery,
  ListDecisionsResult,
} from "./decision-log.js";

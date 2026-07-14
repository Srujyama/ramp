/**
 * @ramp/ledger — dal.ts (the anti-injection seam)
 *
 * The Data Access Layer. This is where the AUTHORITATIVE, security-critical facts
 * are read — always from the SQLite fact store, NEVER from the model's narration.
 * The hook uses the untrusted `SpendRequest` fields ONLY as lookup keys here; the
 * values that come back out are the ground truth the policy kernel judges.
 *
 * `contextFor(req)` returns the `AuthoritativeContext` the @ramp/shared fact
 * translator consumes (`factsFromContext` / `translateToFacts`). The field names
 * mirror the shape described by the shared contract exactly (camelCase context,
 * which the translator maps to the snake_case `Facts`).
 */
import type { SpendRequest } from "@ramp/shared";
import type { LedgerDb } from "./db.js";

/**
 * The authoritative context for ONE spend request, assembled purely from DB
 * reads. This is the exact hand-off shape the @ramp/shared translator turns into
 * a `Facts` object. camelCase here → snake_case in `Facts`.
 */
export interface AuthoritativeContext {
  /** True iff the request's vendor is present AND verified in the registry. */
  readonly vendorVerified: boolean;
  /** The requesting agent's total spend so far today (sum of today's ledger rows). */
  readonly dailyTotalSoFar: number;
  /** Org single-transaction cap. */
  readonly perTxnCap: number;
  /** Org daily aggregate limit. */
  readonly dailyLimit: number;
  /** Categories the org has approved for spend. */
  readonly approvedCategories: readonly string[];
  /** Categories THIS agent is cleared to spend in. */
  readonly agentClearedCategories: readonly string[];
}

/** Org policy limits, read from the single-row `policy_limits` table. */
export interface Limits {
  readonly perTxnCap: number;
  readonly dailyLimit: number;
  readonly currency: string;
}

/**
 * LedgerFactSource — the authoritative fact source over a live SQLite handle.
 * Implements the shape @ramp/shared's `AuthoritativeFactSource` expects
 * (`contextFor(req)`), built entirely from pure DB reads.
 */
export class LedgerFactSource {
  readonly #db: LedgerDb;

  constructor(db: LedgerDb) {
    this.#db = db;
  }

  /**
   * Sum of the agent's spend so far TODAY (local calendar day), in whole units.
   * Uses SQLite `date()` so "today" is derived in the DB, not from JS narration.
   * Returns 0 when the agent has no spend today.
   */
  getDailyTotalSoFar(agentId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM ledger_entries
          WHERE agent_id = ?
            AND date(ts) = date('now')`,
      )
      .get(agentId) as { total: number } | undefined;
    return row ? Number(row.total) : 0;
  }

  /**
   * True iff the vendor id is present in the registry AND `verified = 1`.
   * A missing vendor is NOT verified (fail-closed).
   */
  isVendorVerified(vendorId: string): boolean {
    const row = this.#db
      .prepare("SELECT verified FROM vendors WHERE vendor_id = ?")
      .get(vendorId) as { verified: number } | undefined;
    return !!row && row.verified === 1;
  }

  /** Org policy limits (per-txn cap + daily limit). Throws if unprovisioned. */
  getLimits(): Limits {
    const row = this.#db
      .prepare(
        "SELECT per_txn_cap, daily_limit, currency FROM policy_limits WHERE id = 1",
      )
      .get() as
      | { per_txn_cap: number; daily_limit: number; currency: string }
      | undefined;
    if (!row) {
      throw new Error(
        "@ramp/ledger: policy_limits row (id=1) missing — DB is not provisioned.",
      );
    }
    return {
      perTxnCap: Number(row.per_txn_cap),
      dailyLimit: Number(row.daily_limit),
      currency: row.currency,
    };
  }

  /** The org's approved category ids (those with `approved = 1`), sorted. */
  getApprovedCategories(): string[] {
    const rows = this.#db
      .prepare(
        "SELECT category_id FROM categories WHERE approved = 1 ORDER BY category_id",
      )
      .all() as Array<{ category_id: string }>;
    return rows.map((r) => r.category_id);
  }

  /** The category ids THIS agent is cleared to spend in, sorted. */
  getAgentClearances(agentId: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT category_id
           FROM agent_category_clearances
          WHERE agent_id = ?
          ORDER BY category_id`,
      )
      .all(agentId) as Array<{ category_id: string }>;
    return rows.map((r) => r.category_id);
  }

  /**
   * Assemble the full `AuthoritativeContext` for one request. The `SpendRequest`
   * fields are used ONLY as lookup keys (`vendorId`, `requestingAgent`); every
   * returned value is an authoritative DB read.
   */
  contextFor(req: SpendRequest): AuthoritativeContext {
    const limits = this.getLimits();
    return {
      vendorVerified: this.isVendorVerified(req.vendorId),
      dailyTotalSoFar: this.getDailyTotalSoFar(req.requestingAgent),
      perTxnCap: limits.perTxnCap,
      dailyLimit: limits.dailyLimit,
      approvedCategories: this.getApprovedCategories(),
      agentClearedCategories: this.getAgentClearances(req.requestingAgent),
    };
  }
}

/** Convenience: build a `LedgerFactSource` over an already-open DB handle. */
export function makeFactSource(db: LedgerDb): LedgerFactSource {
  return new LedgerFactSource(db);
}

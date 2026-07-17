/**
 * @ramp/ledger — model-pricing.ts (REFERENCE DATA, not a fact)
 *
 * Read/write helpers for the `model_pricing` table: live vendor model prices shown
 * in the demo dashboard's read-only "Pricing" tab.
 *
 * ============================================================================
 * THIS IS NOT ON THE ENFORCEMENT PATH. IT NEVER GATES A DECISION.
 * ============================================================================
 * The whole security thesis is that a `Decision` follows deterministically from
 * `Facts` drawn from authoritative sources. Model prices are NONE of that: they
 * are informational reference data, written by the out-of-band demo control plane
 * (never the hook), and read only by the pricing UI. They are deliberately absent
 * from `Facts`, `translateToFacts`, the kernel, and the fact source (`dal.ts`).
 * If a price ever DID need to gate a decision, it would go through the frozen
 * add-a-fact procedure with provenance and integer units — this table would not
 * be the source. Keeping this file thin and clearly-labeled is the guardrail.
 */
import type { LedgerDb } from "./db.js";

/** Where a price row came from — travels with the data so the UI can label it. */
export type PricingSource = "live" | "cached" | "static-fallback";

/** One model's prices (USD per 1M tokens, decimal strings to keep sub-cent precision). */
export interface ModelPrice {
  readonly provider: string;
  readonly model: string;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly currency: string;
  readonly source: PricingSource;
  readonly fetchedAt: string;
}

interface PricingRow {
  provider: string;
  model: string;
  input_price: string;
  output_price: string;
  currency: string;
  source: string;
  fetched_at: string;
}

/**
 * Upsert a batch of model prices (idempotent by `(provider, model)`). Returns the
 * number of rows written. A single transaction so the pricing table never shows a
 * half-updated snapshot to the reading UI.
 */
export function upsertModelPricing(db: LedgerDb, prices: readonly ModelPrice[]): number {
  const stmt = db.prepare(
    `INSERT INTO model_pricing (provider, model, input_price, output_price, currency, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model) DO UPDATE SET
       input_price = excluded.input_price,
       output_price = excluded.output_price,
       currency = excluded.currency,
       source = excluded.source,
       fetched_at = excluded.fetched_at`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    let n = 0;
    for (const p of prices) {
      stmt.run(p.provider, p.model, p.inputPrice, p.outputPrice, p.currency, p.source, p.fetchedAt);
      n++;
    }
    db.exec("COMMIT");
    return n;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** All model prices, ordered by provider then model. Empty array if none loaded yet. */
export function listModelPricing(db: LedgerDb): ModelPrice[] {
  let rows: PricingRow[];
  try {
    rows = db
      .prepare(
        `SELECT provider, model, input_price, output_price, currency, source, fetched_at
           FROM model_pricing ORDER BY provider ASC, model ASC`,
      )
      .all() as unknown as PricingRow[];
  } catch {
    // Table absent (an older DB) → no pricing yet, not an error.
    return [];
  }
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    inputPrice: r.input_price,
    outputPrice: r.output_price,
    currency: r.currency,
    source: r.source as PricingSource,
    fetchedAt: r.fetched_at,
  }));
}

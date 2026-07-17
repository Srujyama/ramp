/**
 * @ramp/control-plane — pricing service tests.
 *
 * These import the COMPILED `../dist/*.js` (built by `pretest: tsc -b`), matching
 * the repo convention. The property that matters: the pricing job NEVER leaves the
 * table blank and NEVER presents fallback data as live — source is always honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLedger, closeLedger, IN_MEMORY_PATH, listModelPricing, type LedgerDb } from "@ramp/ledger";
import { refreshPricing, staticPricing, fetchLivePricing } from "../dist/pricing.js";

async function withDb<T>(fn: (db: LedgerDb) => T | Promise<T>): Promise<T> {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return await fn(db);
  } finally {
    closeLedger(db);
  }
}

const NOW = "2026-07-17T12:00:00.000Z";

test("staticPricing is a non-empty, well-formed, honestly-labeled fallback", () => {
  const rows = staticPricing(NOW);
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.equal(r.source, "static-fallback");
    assert.equal(r.fetchedAt, NOW);
    assert.match(r.inputPrice, /^[0-9.]+$/);
    assert.match(r.outputPrice, /^[0-9.]+$/);
    assert.ok(r.provider && r.model);
  }
});

test("fetchLivePricing returns null when no source URL is configured (static is the default)", async () => {
  const prev = process.env.RAMP_PRICING_URL;
  delete process.env.RAMP_PRICING_URL;
  try {
    assert.equal(await fetchLivePricing(NOW), null);
  } finally {
    if (prev !== undefined) process.env.RAMP_PRICING_URL = prev;
  }
});

test("fetchLivePricing fails gracefully (returns null, never throws) on an unreachable source", async () => {
  const prev = process.env.RAMP_PRICING_URL;
  // A port nothing listens on — must fall back, not crash.
  process.env.RAMP_PRICING_URL = "http://127.0.0.1:9/never";
  try {
    assert.equal(await fetchLivePricing(NOW), null);
  } finally {
    if (prev !== undefined) process.env.RAMP_PRICING_URL = prev;
    else delete process.env.RAMP_PRICING_URL;
  }
});

test("refreshPricing seeds static when the table is empty and never leaves it blank", async () => {
  await withDb(async (db) => {
    assert.equal(listModelPricing(db).length, 0);
    const r = await refreshPricing(db, NOW);
    assert.equal(r.source, "static-fallback");
    const loaded = listModelPricing(db);
    assert.ok(loaded.length >= 4);
    assert.ok(loaded.every((p) => p.source === "static-fallback"));
  });
});

test("refreshPricing is idempotent — a second run keeps one row per (provider, model)", async () => {
  await withDb(async (db) => {
    await refreshPricing(db, NOW);
    const first = listModelPricing(db).length;
    await refreshPricing(db, "2026-07-17T13:00:00.000Z");
    assert.equal(listModelPricing(db).length, first);
  });
});

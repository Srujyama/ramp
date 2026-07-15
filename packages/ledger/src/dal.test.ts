/**
 * @ramp/ledger — dal.test.ts
 *
 * Verifies the seeded hackathon scenario end-to-end against a real, freshly
 * provisioned in-memory SQLite DB (schema + seed), through the authoritative DAL.
 * Run with `node --test` (Node 24 built-in test runner + node:sqlite).
 *
 * Asserted ground truth (from sql/seed.sql):
 *   - agent_47 daily total so far = 1140 (~$1200 headline; NOT 1200 exactly —
 *     the reconciled seed is 600 + 540 so 340 more still allows under 1500).
 *   - acme_corp is verified; sketchy_llc / unknown_labs / missing are NOT.
 *   - caps: per_txn_cap 500, daily_limit 1500.
 *   - approved categories: office_supplies, software, travel (crypto NOT approved).
 *   - agent_47 cleared: office_supplies, software (NOT travel).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import { LedgerFactSource, UnknownAgentError } from "./dal.js";

/** The canonical hero request from PITCH.md's demo beat 1. */
const HERO_REQUEST: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

function withSeededDb<T>(fn: (fs: LedgerFactSource) => T): T {
  // In-memory, fully provisioned (schema + seed) — throwaway per test.
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(new LedgerFactSource(db));
  } finally {
    closeLedger(db);
  }
}

test("agent_47 daily total so far is the reconciled seed 1140 (~$1200)", () => {
  withSeededDb((fs) => {
    assert.equal(fs.getDailyTotalSoFar("agent_47"), 1140);
  });
});

test("a REGISTERED agent with no spend today totals 0", () => {
  withSeededDb((fs) => {
    // agent_12 exists in the registry and simply hasn't spent — an authoritative zero.
    assert.equal(fs.getDailyTotalSoFar("agent_12"), 0);
  });
});

test("an UNKNOWN agent throws rather than reading as zero spend (fail-closed)", () => {
  withSeededDb((fs) => {
    // The distinction this test protects: "spent nothing" and "I have never heard
    // of this identity" must not produce the same number. Returning 0 here would
    // hand an unprovisioned agent a full fresh daily budget.
    assert.throws(() => fs.getDailyTotalSoFar("agent_ghost"), UnknownAgentError);
    assert.throws(
      () => fs.contextFor({ request: { ...HERO_REQUEST, requestingAgent: "agent_ghost" } }),
      UnknownAgentError,
    );
  });
});

test("acme_corp is verified; unverified/missing vendors are not", () => {
  withSeededDb((fs) => {
    assert.equal(fs.isVendorVerified("acme_corp"), true);
    assert.equal(fs.isVendorVerified("sketchy_llc"), false);
    assert.equal(fs.isVendorVerified("unknown_labs"), false);
    assert.equal(fs.isVendorVerified("does_not_exist"), false);
  });
});

test("org limits are per_txn_cap 500 / daily_limit 1500 USD", () => {
  withSeededDb((fs) => {
    const limits = fs.getLimits();
    assert.equal(limits.perTxnCap, 500);
    assert.equal(limits.dailyLimit, 1500);
    assert.equal(limits.currency, "USD");
  });
});

test("approved categories exclude crypto", () => {
  withSeededDb((fs) => {
    const approved = fs.getApprovedCategories();
    assert.deepEqual(approved, ["office_supplies", "software", "travel"]);
    assert.ok(!approved.includes("crypto"));
  });
});

test("agent_47 is cleared for office_supplies + software, NOT travel", () => {
  withSeededDb((fs) => {
    const cleared = fs.getAgentClearances("agent_47");
    assert.deepEqual(cleared, ["office_supplies", "software"]);
    assert.ok(!cleared.includes("travel"));
  });
});

test("contextFor assembles the authoritative context for the hero request", () => {
  withSeededDb((fs) => {
    const req = HERO_REQUEST;
    const ctx = fs.contextFor({ request: req });
    assert.equal(ctx.vendorVerified, true);
    assert.equal(ctx.dailyTotalSoFar, 1140);
    assert.equal(ctx.perTxnCap, 500);
    assert.equal(ctx.dailyLimit, 1500);
    assert.deepEqual(ctx.approvedCategories, [
      "office_supplies",
      "software",
      "travel",
    ]);
    assert.deepEqual(ctx.agentClearedCategories, [
      "office_supplies",
      "software",
    ]);
    // The hero happy path: 1140 + 340 = 1480 <= 1500 (allow) and 340 <= 500 (cap).
    assert.ok(ctx.dailyTotalSoFar + req.amount <= ctx.dailyLimit);
    assert.ok(req.amount <= ctx.perTxnCap);
  });
});

test("contextFor keys off untrusted request fields only as lookup keys", () => {
  withSeededDb((fs) => {
    // A spoofed request naming an unverified vendor + unapproved category must
    // surface the AUTHORITATIVE facts (not the caller's assertions).
    const spoof: SpendRequest = {
      vendorId: "sketchy_llc",
      amount: 999,
      currency: "USD",
      category: "crypto",
      requestingAgent: "agent_47",
    };
    const ctx = fs.contextFor({ request: spoof });
    assert.equal(ctx.vendorVerified, false);
    assert.ok(!ctx.approvedCategories.includes("crypto"));
  });
});

test("attestationPresent comes from the caller's verified verdict, never the request", () => {
  withSeededDb((fs) => {
    // Absent verdict => false (fail-closed default).
    assert.equal(fs.contextFor({ request: HERO_REQUEST }).attestationPresent, false);
    // A verified verdict is threaded in by the attestation layer, out of band.
    assert.equal(
      fs.contextFor({ request: HERO_REQUEST, attestationPresent: true })
        .attestationPresent,
      true,
    );
    // There is no field on SpendRequest that can set this. A request that tries
    // to assert it is simply ignored — the property is not read from the request.
    const liar = { ...HERO_REQUEST, attestationPresent: true } as SpendRequest;
    assert.equal(fs.contextFor({ request: liar }).attestationPresent, false);
  });
});

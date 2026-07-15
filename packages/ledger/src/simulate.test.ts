/**
 * @ramp/ledger — simulate.test.ts (Policy Simulator backend)
 *
 * Exercises the READ-ONLY `simulate()` probe against a real, freshly provisioned
 * in-memory SQLite DB (schema + seed), with the reference kernel injected.
 *
 * The CRITICAL invariant is side-effect-freeness: a simulation reuses the real
 * kernel over authoritative DB reads and MUST NOT persist or execute anything.
 * The "no persistence" test locks that in by asserting the `decisions`,
 * `ledger_entries`, and `decision_executions` row counts are UNCHANGED after
 * running many simulations (allow + every deny variant + throws).
 *
 * Asserted ground truth (from sql/seed.sql; see dal.test.ts):
 *   - acme_corp verified; sketchy_llc NOT.
 *   - caps: per_txn_cap 500, daily_limit 1500; currency USD.
 *   - approved categories: office_supplies, software, travel (crypto NOT).
 *   - agent_47 cleared: office_supplies, software (NOT travel).
 *   - agent_47 daily total so far = 1140.
 *
 * Run with `node --test` (Node 24 + node:sqlite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceKernel } from "@ramp/gate";
import { openLedger, closeLedger, IN_MEMORY_PATH, type LedgerDb } from "./db.js";
import { simulate } from "./simulate.js";

function withSeededDb<T>(fn: (db: LedgerDb) => T): T {
  // In-memory, fully provisioned (schema + seed) — throwaway per test.
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

/** Count rows in a table (identifier is a test-local constant, never user input). */
function countRows(db: LedgerDb, table: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return Number(row.n);
}

test("ALLOW: verified vendor, approved+cleared category, within caps", () => {
  withSeededDb((db) => {
    const result = simulate(
      db,
      {
        agent: "agent_47",
        vendor: "acme_corp",
        amount: 300, // <= 500 cap, and 1140 + 300 = 1440 <= 1500 daily
        category: "office_supplies",
      },
      referenceKernel,
    );

    assert.equal(result.outcome, "allow");
    assert.deepEqual(result.firedRules, ["allow/all_conditions_met"]);
    assert.equal(result.simulationOnly, true);
    assert.ok(result.policyDigest.startsWith("sha256:"));
    // The resolved facts are the AUTHORITATIVE ones, not the caller's narration.
    assert.equal(result.facts.vendor_verified, true);
    assert.equal(result.facts.daily_total_so_far, 1140);
    assert.equal(result.currency, "USD"); // defaulted from org limits
  });
});

test("currency defaults from org limits, but is overridable", () => {
  withSeededDb((db) => {
    const defaulted = simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 10, category: "software" },
      referenceKernel,
    );
    assert.equal(defaulted.currency, "USD");

    const overridden = simulate(
      db,
      {
        agent: "agent_47",
        vendor: "acme_corp",
        amount: 10,
        category: "software",
        currency: "EUR",
      },
      referenceKernel,
    );
    assert.equal(overridden.currency, "EUR");
  });
});

test("DENY: unverified vendor → deny/vendor_not_verified", () => {
  withSeededDb((db) => {
    const result = simulate(
      db,
      {
        agent: "agent_47",
        vendor: "sketchy_llc",
        amount: 100,
        category: "office_supplies",
      },
      referenceKernel,
    );
    assert.equal(result.outcome, "deny");
    assert.ok(result.firedRules.includes("deny/vendor_not_verified"));
    assert.equal(result.simulationOnly, true);
  });
});

test("DENY: over per-txn cap → deny/over_per_txn_cap", () => {
  withSeededDb((db) => {
    const result = simulate(
      db,
      {
        agent: "agent_47",
        vendor: "acme_corp",
        amount: 600, // > 500 per_txn_cap
        category: "office_supplies",
      },
      referenceKernel,
    );
    assert.equal(result.outcome, "deny");
    assert.ok(result.firedRules.includes("deny/over_per_txn_cap"));
  });
});

test("DENY: category not approved → deny/category_not_approved", () => {
  withSeededDb((db) => {
    const result = simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 50, category: "crypto" },
      referenceKernel,
    );
    assert.equal(result.outcome, "deny");
    assert.ok(result.firedRules.includes("deny/category_not_approved"));
  });
});

test("DENY: agent not cleared for category → deny/agent_uncleared_for_category", () => {
  withSeededDb((db) => {
    // travel IS approved org-wide, but agent_47 is NOT cleared for it, so this
    // isolates the clearance deny.
    const result = simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 50, category: "travel" },
      referenceKernel,
    );
    assert.equal(result.outcome, "deny");
    assert.deepEqual(result.firedRules, ["deny/agent_uncleared_for_category"]);
  });
});

test("DENY: request would exceed the daily limit → deny/daily_limit_exceeded", () => {
  withSeededDb((db) => {
    // 1140 + 400 = 1540 > 1500 daily_limit, but 400 <= 500 cap and everything
    // else holds, so this isolates the daily-limit deny.
    const result = simulate(
      db,
      {
        agent: "agent_47",
        vendor: "acme_corp",
        amount: 400,
        category: "office_supplies",
      },
      referenceKernel,
    );
    assert.equal(result.outcome, "deny");
    assert.deepEqual(result.firedRules, ["deny/daily_limit_exceeded"]);
  });
});

test("invalid amount (negative / NaN) throws", () => {
  withSeededDb((db) => {
    assert.throws(() =>
      simulate(
        db,
        { agent: "agent_47", vendor: "acme_corp", amount: -1, category: "software" },
        referenceKernel,
      ),
    );
    assert.throws(() =>
      simulate(
        db,
        {
          agent: "agent_47",
          vendor: "acme_corp",
          amount: Number.NaN,
          category: "software",
        },
        referenceKernel,
      ),
    );
  });
});

test("NO PERSISTENCE: simulations never write a ledger row", () => {
  withSeededDb((db) => {
    const before = {
      decisions: countRows(db, "decisions"),
      ledger: countRows(db, "ledger_entries"),
      executions: countRows(db, "decision_executions"),
    };

    // A representative mix: an allow, one of each deny, and two throwing calls.
    simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 300, category: "office_supplies" },
      referenceKernel,
    );
    simulate(
      db,
      { agent: "agent_47", vendor: "sketchy_llc", amount: 100, category: "office_supplies" },
      referenceKernel,
    );
    simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 600, category: "office_supplies" },
      referenceKernel,
    );
    simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 50, category: "crypto" },
      referenceKernel,
    );
    simulate(
      db,
      { agent: "agent_47", vendor: "acme_corp", amount: 400, category: "office_supplies" },
      referenceKernel,
    );
    assert.throws(() =>
      simulate(
        db,
        { agent: "agent_47", vendor: "acme_corp", amount: -5, category: "software" },
        referenceKernel,
      ),
    );

    const after = {
      decisions: countRows(db, "decisions"),
      ledger: countRows(db, "ledger_entries"),
      executions: countRows(db, "decision_executions"),
    };

    assert.deepEqual(after, before, "no simulation may write any ledger row");
  });
});

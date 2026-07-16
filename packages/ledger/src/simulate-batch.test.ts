/**
 * @ramp/ledger — simulate-batch.test.ts
 *
 * Batch preview = many read-only `simulate()` calls + the counterfactual, rolled
 * up. Two things must hold: (1) it stays side-effect-free (no rows written), and
 * (2) it is HONEST about compounding — an agent whose previewed-allow amounts sum
 * past their daily headroom is flagged as overcommitted, never quietly presented
 * as "all clear".
 *
 * Seeded ground truth (sql/seed.sql): acme_corp verified, sketchy_llc NOT;
 * per_txn_cap 500, daily_limit 1500; agent_47 cleared office_supplies+software,
 * daily total so far 1140 (so 360 headroom).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceKernel } from "@ramp/gate";
import { openLedger, closeLedger, IN_MEMORY_PATH, type LedgerDb } from "./db.js";
import { simulateBatch } from "./simulate-batch.js";
import type { SimulationInput } from "./simulate.js";

function withSeededDb<T>(fn: (db: LedgerDb) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

function countRows(db: LedgerDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

test("batch preview writes nothing (side-effect-free)", () => {
  withSeededDb((db) => {
    const before = {
      decisions: countRows(db, "decisions"),
      entries: countRows(db, "ledger_entries"),
      execs: countRows(db, "decision_executions"),
    };
    simulateBatch(
      db,
      [
        { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "office_supplies" },
        { agent: "agent_47", vendor: "sketchy_llc", amount: 50, category: "office_supplies" },
        { agent: "agent_47", vendor: "acme_corp", amount: 900, category: "office_supplies" },
      ],
      referenceKernel,
    );
    assert.equal(countRows(db, "decisions"), before.decisions);
    assert.equal(countRows(db, "ledger_entries"), before.entries);
    assert.equal(countRows(db, "decision_executions"), before.execs);
  });
});

test("each item is judged by the real kernel and carries its counterfactual", () => {
  withSeededDb((db) => {
    const batch = simulateBatch(
      db,
      [
        { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "office_supplies" },
        { agent: "agent_47", vendor: "acme_corp", amount: 900, category: "office_supplies" },
        { agent: "agent_47", vendor: "sketchy_llc", amount: 50, category: "office_supplies" },
      ],
      referenceKernel,
    );
    assert.equal(batch.items.length, 3);
    // 100: within cap and 1140+100<=1500 -> allow.
    assert.equal(batch.items[0]!.result.outcome, "allow");
    // 900: over cap AND over daily -> deny; counterfactual = min(cap 500, headroom 360)=360.
    assert.equal(batch.items[1]!.result.outcome, "deny");
    assert.equal(batch.items[1]!.explanation.counterfactual.maxAllowAmount, 360);
    // sketchy_llc: unverified -> deny; categorical, no amount clears it.
    assert.equal(batch.items[2]!.result.outcome, "deny");
    assert.equal(batch.items[2]!.explanation.counterfactual.maxAllowAmount, null);
  });
});

test("aggregate splits money into flowed / held / denied", () => {
  withSeededDb((db) => {
    const { aggregate } = simulateBatch(
      db,
      [
        { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "office_supplies" }, // allow
        { agent: "agent_47", vendor: "acme_corp", amount: 900, category: "office_supplies" }, // deny
      ],
      referenceKernel,
    );
    assert.equal(aggregate.total, 2);
    assert.equal(aggregate.counts.allow, 1);
    assert.equal(aggregate.counts.deny, 1);
    assert.equal(aggregate.flowed, 100);
    assert.equal(aggregate.denied, 900);
    assert.equal(aggregate.held, 0);
  });
});

test("OVERCOMMIT: three allows that each fit, but together bust the daily headroom", () => {
  // agent_47 has 360 headroom (1500 - 1140). Three $200 office_supplies payments
  // each preview as allow independently (1140+200<=1500), but 3*200=600 > 360.
  withSeededDb((db) => {
    const three: SimulationInput[] = [200, 200, 200].map((amount, i) => ({
      agent: "agent_47",
      vendor: "acme_corp",
      amount,
      category: "office_supplies",
      // distinct so duplicate-detection doesn't escalate later copies
      currency: "USD",
    }));
    // Give them different categories? No — keep office_supplies; duplicate detection
    // is against the LEDGER, not intra-batch, and preview doesn't compound, so all
    // three preview allow. That is exactly the situation the overcommit flag exists for.
    const { aggregate, items } = simulateBatch(db, three, referenceKernel);
    assert.ok(items.every((it) => it.result.outcome === "allow"), "each fits independently");
    assert.equal(aggregate.overcommitted.length, 1);
    const oc = aggregate.overcommitted[0]!;
    assert.equal(oc.agent, "agent_47");
    assert.equal(oc.allowedSum, 600);
    assert.equal(oc.remainingToday, 360);
    assert.equal(oc.atRiskCount, 3);
  });
});

test("no overcommit when the allowed sum fits the headroom", () => {
  withSeededDb((db) => {
    const { aggregate } = simulateBatch(
      db,
      [
        { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "office_supplies" },
        { agent: "agent_47", vendor: "acme_corp", amount: 200, category: "office_supplies" },
      ],
      referenceKernel,
    );
    // 100 + 200 = 300 <= 360 headroom.
    assert.equal(aggregate.overcommitted.length, 0);
  });
});

test("determinism: the same batch previews deep-equal twice", () => {
  withSeededDb((db) => {
    const batch: SimulationInput[] = [
      { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "office_supplies" },
      { agent: "agent_47", vendor: "acme_corp", amount: 900, category: "office_supplies" },
    ];
    const a = simulateBatch(db, batch, referenceKernel);
    const b = simulateBatch(db, batch, referenceKernel);
    assert.deepEqual(a, b);
  });
});

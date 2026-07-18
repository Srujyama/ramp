/**
 * @ramp/ledger — admin-writes.test.ts
 *
 * The demo control plane's ONLY mutation surface: typed writes to INPUT tables.
 * These tests pin the two properties that make it safe:
 *
 *   1. It writes INPUTS the kernel reads (an agent + its clearances, the dials),
 *      so the NEXT decision changes — provably, via the fact source that feeds
 *      the gate — without ever authoring a decision.
 *   2. It refuses anything that would poison a later decision: a duplicate agent,
 *      a clearance for a non-existent category, a non-integer / out-of-range dial.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import { LedgerFactSource } from "./dal.js";
import { createAgent, updatePolicyDials, readDials } from "./admin-writes.js";
import type { LedgerDb } from "./db.js";

function withSeededDb<T>(fn: (db: LedgerDb) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

// --- createAgent -------------------------------------------------------------

test("createAgent registers an agent the fact source can then serve facts for", () => {
  withSeededDb((db) => {
    const created = createAgent(db, { agentId: "agent_new", displayName: "Ops Bot", clearedCategories: ["office_supplies", "software"] });
    assert.equal(created.agentId, "agent_new");
    assert.deepEqual([...created.clearedCategories].sort(), ["office_supplies", "software"]);

    const fs = new LedgerFactSource(db);
    assert.equal(fs.agentExists("agent_new"), true);
    assert.deepEqual(fs.getAgentClearances("agent_new").sort(), ["office_supplies", "software"]);
  });
});

test("createAgent refuses a duplicate agent id", () => {
  withSeededDb((db) => {
    assert.throws(() => createAgent(db, { agentId: "agent_47", displayName: "Dup", clearedCategories: [] }), /already exists/);
  });
});

test("createAgent refuses a clearance for a category that does not exist", () => {
  withSeededDb((db) => {
    assert.throws(
      () => createAgent(db, { agentId: "agent_x", displayName: "X", clearedCategories: ["not_a_real_category"] }),
      /does not exist/,
    );
    // and the agent must NOT have been half-created (the write is atomic)
    assert.equal(new LedgerFactSource(db).agentExists("agent_x"), false);
  });
});

test("createAgent requires a non-empty id and display name", () => {
  withSeededDb((db) => {
    assert.throws(() => createAgent(db, { agentId: "", displayName: "X", clearedCategories: [] }), /agentId is required/);
    assert.throws(() => createAgent(db, { agentId: "y", displayName: "  ", clearedCategories: [] }), /displayName is required/);
  });
});

// --- updatePolicyDials -------------------------------------------------------

test("updatePolicyDials changes what the fact source reports as limits", () => {
  withSeededDb((db) => {
    const before = new LedgerFactSource(db).getLimits();
    assert.equal(before.perTxnCap, 500); // seeded ground truth

    const after = updatePolicyDials(db, { perTxnCap: 800, escalationThreshold: 300 });
    assert.equal(after.perTxnCap, 800);
    assert.equal(after.escalationThreshold, 300);
    // untouched dials are preserved
    assert.equal(after.dailyLimit, before.dailyLimit);

    // and the CHANGE is visible through the very fact source the gate reads
    const limits = new LedgerFactSource(db).getLimits();
    assert.equal(limits.perTxnCap, 800);
    assert.equal(limits.escalationThreshold, 300);
  });
});

test("updatePolicyDials only touches the keys given", () => {
  withSeededDb((db) => {
    const before = readDials(db);
    updatePolicyDials(db, { dailyLimit: 2500 });
    const after = readDials(db);
    assert.equal(after.dailyLimit, 2500);
    assert.equal(after.perTxnCap, before.perTxnCap);
    assert.equal(after.velocityLimit, before.velocityLimit);
  });
});

test("updatePolicyDials rejects non-integer, negative, and out-of-range dials", () => {
  withSeededDb((db) => {
    assert.throws(() => updatePolicyDials(db, { perTxnCap: 1.5 }), /whole number/);
    assert.throws(() => updatePolicyDials(db, { dailyLimit: -1 }), /must not be negative/);
    assert.throws(() => updatePolicyDials(db, { velocityLimit: 3_000_000_000 }), /integer range/);
  });
});

test("updatePolicyDials refuses a no-op patch (no recognised dial)", () => {
  withSeededDb((db) => {
    assert.throws(() => updatePolicyDials(db, {} as never), /no recognised dial/);
  });
});

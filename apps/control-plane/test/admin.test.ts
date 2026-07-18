/**
 * @ramp/control-plane — admin write tests.
 *
 * The property that matters: the admin surface administers INPUTS and nothing
 * else. Creating an agent or retuning a dial changes what the NEXT decision will
 * be (visible through the same fact source the gate reads) — and malformed input
 * is rejected before it can touch the DB. It never writes a decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLedger, closeLedger, IN_MEMORY_PATH, LedgerFactSource, type LedgerDb } from "@ramp/ledger";
import { runCreateAgent, runUpdateDials, adminState, parseNewAgent, parseDialPatch } from "../dist/admin.js";

function withDb<T>(fn: (db: LedgerDb) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

test("runCreateAgent registers an agent the gate's fact source can then serve", () => {
  withDb((db) => {
    const out = runCreateAgent(db, { agentId: "agent_demo", displayName: "Demo Bot", clearedCategories: ["software"] });
    assert.ok(!("error" in out) && out.agentId === "agent_demo");
    const fs = new LedgerFactSource(db);
    assert.equal(fs.agentExists("agent_demo"), true);
    assert.deepEqual(fs.getAgentClearances("agent_demo"), ["software"]);
  });
});

test("runCreateAgent returns a typed error (not a throw) for bad input", () => {
  withDb((db) => {
    assert.ok("error" in runCreateAgent(db, { agentId: "", displayName: "x", clearedCategories: [] }));
    assert.ok("error" in runCreateAgent(db, { agentId: "a", displayName: "b", clearedCategories: ["nope"] }));
    assert.ok("error" in runCreateAgent(db, { agentId: "agent_47", displayName: "dup", clearedCategories: [] }));
  });
});

test("runUpdateDials changes what the gate measures the next decision against", () => {
  withDb((db) => {
    const out = runUpdateDials(db, { perTxnCap: 750 });
    assert.ok(!("error" in out) && out.perTxnCap === 750);
    assert.equal(new LedgerFactSource(db).getLimits().perTxnCap, 750);
  });
});

test("runUpdateDials returns a typed error for a non-integer or empty patch", () => {
  withDb((db) => {
    assert.ok("error" in runUpdateDials(db, { perTxnCap: 1.25 }));
    assert.ok("error" in runUpdateDials(db, {}));
  });
});

test("adminState reports the current dials + approved categories for the form", () => {
  withDb((db) => {
    const s = adminState(db);
    assert.equal(s.dials.perTxnCap, 500); // seeded ground truth
    assert.ok(s.categories.includes("office_supplies"));
  });
});

test("parse helpers accept well-formed and reject malformed bodies", () => {
  assert.ok(!("error" in parseNewAgent({ agentId: "a", displayName: "b", clearedCategories: ["software"] })));
  assert.ok("error" in parseNewAgent({ agentId: "a" }));
  assert.ok("error" in parseNewAgent({ agentId: "a", displayName: "b", clearedCategories: [1, 2] }));
  assert.ok(!("error" in parseDialPatch({ dailyLimit: 2000 })));
  assert.ok("error" in parseDialPatch({ dailyLimit: "lots" }));
  assert.ok("error" in parseDialPatch({ unknownKey: 5 }));
});

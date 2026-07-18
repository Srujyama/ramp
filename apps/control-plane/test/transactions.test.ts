/**
 * @ramp/control-plane — transaction driver tests.
 *
 * The property that matters: a UI-triggered transaction is a REAL gated decision.
 * `runTransaction` never chooses the outcome — it hands the intent to the actual
 * requestPurchase lifecycle, and allow/deny/escalate falls out of policy. A valid
 * attested request within limits ALLOWS; drop the attestation and it DENIES; an
 * unverified vendor DENIES — exactly as the hook would decide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRampClient } from "@ramp/client";
import { openLedger, closeLedger, type LedgerDb } from "@ramp/ledger";
import { runTransaction, parseIntent } from "../dist/transactions.js";

const NOW = 1_784_000_000_000;

/** A shared on-disk ledger so the client and the vendor-domain lookup agree. */
async function withEnv<T>(fn: (ramp: ReturnType<typeof createRampClient>, db: LedgerDb) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `cp-tx-${randomUUID()}.db`);
  const db = openLedger(path, { provisionIfEmpty: true, seed: true });
  const ramp = createRampClient({ dbPath: path });
  try {
    return await fn(ramp, db);
  } finally {
    ramp.close();
    closeLedger(db);
    for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
  }
}

test("a valid attested request within limits is ALLOWED and recorded", async () => {
  await withEnv(async (ramp, db) => {
    const r = await runTransaction(ramp, db, { agent: "agent_47", vendor: "acme_corp", amount: 150, category: "office_supplies", attest: true }, NOW);
    assert.equal(r.status, "allowed");
    assert.equal(r.outcome, "allow");
    assert.ok(r.decisionId);
    assert.ok(r.firedRules.includes("allow/all_conditions_met"));
    // it's a REAL recorded decision — visible in the log
    assert.ok(ramp.decisions(10).some((d) => d.decisionId === r.decisionId));
  });
});

test("dropping the attestation DENIES (the gate decides, not the control plane)", async () => {
  await withEnv(async (ramp, db) => {
    const r = await runTransaction(ramp, db, { agent: "agent_47", vendor: "acme_corp", amount: 150, category: "office_supplies", attest: false }, NOW);
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/attestation_invalid"));
  });
});

test("an unverified vendor DENIES even when 'attest' is requested", async () => {
  await withEnv(async (ramp, db) => {
    const r = await runTransaction(ramp, db, { agent: "agent_47", vendor: "sketchy_llc", amount: 50, category: "office_supplies", attest: true }, NOW);
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/vendor_not_verified"));
  });
});

test("over the per-txn cap DENIES on arithmetic", async () => {
  await withEnv(async (ramp, db) => {
    const r = await runTransaction(ramp, db, { agent: "agent_47", vendor: "acme_corp", amount: 9000, category: "office_supplies", attest: true }, NOW);
    assert.equal(r.status, "denied");
    assert.ok(r.firedRules.includes("deny/over_per_txn_cap"));
  });
});

// --- parseIntent (input validation, no DB) ----------------------------------

test("parseIntent accepts a well-formed intent and rejects malformed ones", () => {
  const ok = parseIntent({ agent: "agent_47", vendor: "acme_corp", amount: 100, category: "office_supplies", attest: true });
  assert.ok(!("error" in ok) && ok.amount === 100 && ok.attest === true);

  assert.ok("error" in parseIntent(null));
  assert.ok("error" in parseIntent({ agent: "a", vendor: "v", category: "c", amount: 1.5, attest: true })); // non-integer
  assert.ok("error" in parseIntent({ agent: "a", vendor: "v", category: "c", amount: -5, attest: true })); // negative
  assert.ok("error" in parseIntent({ agent: "a", vendor: "v", category: "c", amount: 1 })); // missing attest
  assert.ok("error" in parseIntent({ agent: "", vendor: "v", category: "c", amount: 1, attest: true })); // empty agent
});

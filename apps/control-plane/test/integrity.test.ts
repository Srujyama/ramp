/**
 * @ramp/control-plane — ledger integrity tests.
 *
 * The property that matters: the tamper-evidence round-trip is real. A signed head
 * receipt witnesses (head, length); verifying it against an unchanged (or grown)
 * chain is consistent, and a garbage receipt is refused. The signing + verifying
 * use the real chain + demo gate key, exactly like the CLI (pnpm head / pnpm proof).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRampClient } from "@ramp/client";
import { openLedger, closeLedger, type LedgerDb } from "@ramp/ledger";
import { runTransaction } from "../dist/transactions.js";
import { chainStatus, makeReceipt, checkReceipt } from "../dist/integrity.js";

const NOW = "2026-07-18T00:00:00.000Z";

async function withEnv<T>(fn: (ramp: ReturnType<typeof createRampClient>, db: LedgerDb) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `cp-int-${randomUUID()}.db`);
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

test("chainStatus reports a valid chain that grows as decisions land", async () => {
  await withEnv(async (ramp, db) => {
    const before = chainStatus(db);
    assert.equal(before.valid, true);
    assert.equal(before.defects, 0);
    await runTransaction(ramp, db, { agent: "agent_12", vendor: "acme_corp", amount: 100, category: "office_supplies", attest: true }, Date.parse(NOW));
    const after = chainStatus(db);
    assert.equal(after.valid, true);
    assert.equal(after.length, before.length + 1);
  });
});

test("a signed receipt verifies against the chain it witnessed, and after it grows", async () => {
  await withEnv(async (ramp, db) => {
    const receipt = makeReceipt(db, NOW);
    const now = checkReceipt(db, receipt);
    assert.ok(!("error" in now) && now.consistent && now.code === "ok");

    // append more; the earlier receipt is still a consistent PREFIX
    await runTransaction(ramp, db, { agent: "agent_12", vendor: "acme_corp", amount: 100, category: "office_supplies", attest: true }, Date.parse(NOW));
    const later = checkReceipt(db, receipt);
    assert.ok(!("error" in later) && later.consistent && later.grownBy >= 1);
  });
});

test("checkReceipt refuses a body that isn't a receipt", async () => {
  await withEnv(async (_ramp, db) => {
    const out = checkReceipt(db, { not: "a receipt" });
    assert.ok(!("error" in out) && out.consistent === false && out.code === "malformed");
  });
});

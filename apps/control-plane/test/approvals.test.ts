/**
 * @ramp/control-plane — human-approval channel tests.
 *
 * The property that matters: a held decision can be resolved ONLY through a real
 * signed approval, and the queue reflects it. runResolve mints the signature with
 * the chosen demo approver's key (the key is the identity), binds it to the
 * decision's digest, and records it via resolveEscalation — the same human channel
 * the CLI uses. A held decision appears in the pending queue; once approved it
 * leaves; approving something that isn't held is refused with a typed code.
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
import { listPending, runResolve, parseResolveBody } from "../dist/approvals.js";

const NOW = "2026-07-18T00:00:00.000Z";

async function withEnv<T>(fn: (ramp: ReturnType<typeof createRampClient>, db: LedgerDb) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `cp-appr-${randomUUID()}.db`);
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

/** agent_12 (0 spent, cleared for office_supplies) at $450 is over the $400 escalation threshold but under the $500 cap -> HELD. */
async function makeHeld(ramp: ReturnType<typeof createRampClient>, db: LedgerDb): Promise<string> {
  const r = await runTransaction(ramp, db, { agent: "agent_12", vendor: "acme_corp", amount: 450, category: "office_supplies", attest: true }, Date.parse(NOW));
  assert.equal(r.outcome, "escalate", `expected a held decision, got ${r.outcome} (${r.firedRules.join(",")})`);
  return r.decisionId!;
}

test("a held decision appears in the pending queue, and a signed approval clears it", async () => {
  await withEnv(async (ramp, db) => {
    const id = await makeHeld(ramp, db);
    assert.ok(listPending(db).some((p) => p.decisionId === id), "held decision should be pending");

    const rec = runResolve(db, { decisionId: id, verdict: "approved", approverKeyId: "approver_alice", note: "ok by me" }, NOW);
    assert.ok(!("error" in rec), `resolve failed: ${(rec as { error?: string }).error}`);
    assert.equal(rec.verdict, "approved");
    assert.equal(rec.approvedBy, "alice"); // identity comes from the KEY, not a claim
    assert.equal(rec.note, "ok by me");

    assert.ok(!listPending(db).some((p) => p.decisionId === id), "resolved decision should leave the queue");
  });
});

test("resolving the same decision twice is refused", async () => {
  await withEnv(async (ramp, db) => {
    const id = await makeHeld(ramp, db);
    runResolve(db, { decisionId: id, verdict: "approved", approverKeyId: "approver_alice" }, NOW);
    const second = runResolve(db, { decisionId: id, verdict: "rejected", approverKeyId: "approver_bob" }, NOW);
    assert.ok("error" in second && second.code === "already_resolved");
  });
});

test("approving a decision that isn't held is refused", async () => {
  await withEnv(async (ramp, db) => {
    // an ordinary allow, not a held decision
    const r = await runTransaction(ramp, db, { agent: "agent_12", vendor: "acme_corp", amount: 120, category: "office_supplies", attest: true }, Date.parse(NOW));
    assert.equal(r.outcome, "allow");
    const out = runResolve(db, { decisionId: r.decisionId!, verdict: "approved", approverKeyId: "approver_alice" }, NOW);
    assert.ok("error" in out && out.code === "not_escalated");
  });
});

test("parseResolveBody rejects a bad verdict / unknown approver", () => {
  assert.ok("error" in parseResolveBody({ decisionId: "d", verdict: "maybe", approverKeyId: "approver_alice" }));
  assert.ok("error" in parseResolveBody({ decisionId: "d", verdict: "approved", approverKeyId: "approver_zzz" }));
  assert.ok(!("error" in parseResolveBody({ decisionId: "d", verdict: "approved", approverKeyId: "approver_alice" })));
});

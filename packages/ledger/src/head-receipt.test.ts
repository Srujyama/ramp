/**
 * @ramp/ledger — head-receipt.test.ts
 *
 * The chain catches deletion and reordering. It CANNOT catch a full-suffix
 * rewrite: recompute every link from the edit point and the result is internally
 * perfect. A receipt is what catches that — and only because the auditor held a
 * copy from before.
 *
 * The load-bearing test is `THE POINT: a full-suffix rewrite is invisible to the
 * chain and caught by a receipt`. It asserts both halves: verifyChain says
 * INTACT, and the receipt says REWRITTEN. If the first half ever starts failing,
 * this file is testing the wrong thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision, Facts, SpendRequest } from "@ramp/shared";
import { demoGateKeyring, demoGatePrivateKey, DEMO_GATE_KEY_ID } from "@ramp/provenance";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import type { LedgerDb } from "./db.js";
import { recordDecision } from "./decision-log.js";
import { buildProof } from "./proof.js";
import { verifyChain, chainHead } from "./chain.js";
import { publishHead, verifyAgainstReceipt } from "./head-receipt.js";

const REQ: SpendRequest = {
  vendorId: "acme_corp",
  amount: 100,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv",
  requestingAgent: "agent_47",
};
const FACTS: Facts = {
  request_id: "inv",
  requesting_agent: "agent_47",
  amount: 100,
  vendor: "acme_corp",
  category: "office_supplies",
  vendor_verified: true,
  daily_total_so_far: 0,
  per_txn_cap: 500,
  daily_limit: 1500,
  approved_categories: ["office_supplies"],
  agent_cleared_categories: ["office_supplies"],
  attestation_present: true,
  escalation_threshold: 400,
  vendor_risk_tier: "standard",
  budgets: [],
  recent_txn_count: 0,
  velocity_limit: 6,
};
const ALLOW: Decision = {
  decision: "allow",
  reasons: ["all_conditions_met"],
  firedRules: ["allow/all_conditions_met"],
};

function withDb<T>(fn: (db: LedgerDb) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

function record(db: LedgerDb, i: number): void {
  const decisionId = `d${String(i).padStart(3, "0")}`;
  const proof = buildProof({
    decisionId,
    request: REQ,
    decision: ALLOW,
    facts: FACTS,
    producedAt: 1_770_000_000_000 + i,
  });
  recordDecision(db, { decisionId, request: REQ, facts: FACTS, decision: ALLOW, proof });
}

const receiptNow = (db: LedgerDb, at = "2026-07-15T12:00:00Z") =>
  publishHead(db, demoGatePrivateKey(), DEMO_GATE_KEY_ID, at);

const check = (db: LedgerDb, r: unknown) => verifyAgainstReceipt(db, r, demoGateKeyring());

// ---------------------------------------------------------------------------
// The chain is allowed to GROW. That is the whole reason bare heads failed.
// ---------------------------------------------------------------------------

test("a receipt stays consistent as the chain grows — the head SHOULD change", () => {
  // This is what `expectedHead === currentHead` got wrong: an honest append moves
  // the head, so a bare comparison fires on normal operation, and a check that
  // cries wolf on every legitimate payment is a check nobody runs.
  withDb((db) => {
    for (let i = 1; i <= 3; i++) record(db, i);
    const receipt = receiptNow(db);
    const headThen = chainHead(db).head;

    for (let i = 4; i <= 8; i++) record(db, i);
    assert.notEqual(chainHead(db).head, headThen, "the head must move when the chain grows");

    const r = check(db, receipt);
    assert.equal(r.consistent, true, "growth is not tampering");
    assert.equal(r.code, "ok");
    assert.equal(r.grownBy, 5);
  });
});

test("a receipt is consistent with the exact chain it was taken from", () => {
  withDb((db) => {
    for (let i = 1; i <= 4; i++) record(db, i);
    const r = check(db, receiptNow(db));
    assert.equal(r.consistent, true);
    assert.equal(r.grownBy, 0);
  });
});

test("a genesis receipt is consistent with anything", () => {
  withDb((db) => {
    const receipt = receiptNow(db); // empty chain
    assert.equal(receipt.statement.length, 0);
    for (let i = 1; i <= 3; i++) record(db, i);
    const r = check(db, receipt);
    assert.equal(r.consistent, true);
    assert.equal(r.grownBy, 3);
  });
});

// ---------------------------------------------------------------------------
// THE POINT.
// ---------------------------------------------------------------------------

test("THE POINT: a full-suffix rewrite is invisible to the chain and caught by a receipt", () => {
  withDb((db) => {
    for (let i = 1; i <= 5; i++) record(db, i);
    const receipt = receiptNow(db); // the auditor's copy, from before

    // The determined attack: wipe history and rebuild it from position 3, so
    // every link recomputes cleanly. This is the one thing the chain cannot see.
    db.exec("DELETE FROM decisions WHERE seq >= 3");
    for (let i = 30; i <= 32; i++) record(db, i);

    // The chain itself is PERFECTLY HAPPY. Every link verifies. This assertion is
    // the important half of the test: it pins WHY receipts exist.
    const chain = verifyChain(db);
    assert.equal(chain.valid, true, "a rewritten suffix is internally consistent — that is the problem");

    // The receipt is not.
    const r = check(db, receipt);
    assert.equal(r.consistent, false, "the receipt MUST catch what the chain cannot");
    assert.equal(r.code, "history_rewritten");
    assert.match(r.detail, /REWRITTEN/);
  });
});

test("truncating history below the witnessed length is caught", () => {
  withDb((db) => {
    for (let i = 1; i <= 6; i++) record(db, i);
    const receipt = receiptNow(db);

    db.exec("DELETE FROM decisions WHERE seq > 2");

    const r = check(db, receipt);
    assert.equal(r.consistent, false);
    assert.equal(r.code, "history_truncated");
    assert.match(r.detail, /demonstrably existed are gone/);
  });
});

test("THE DIVISION OF LABOUR: an in-prefix edit is caught by the CHAIN, not the receipt", () => {
  // Written expecting the receipt to catch this. It does not, and the reason is
  // worth pinning rather than papering over:
  //
  // The receipt checks ONE position — its own `length`. Editing a link deeper in
  // the prefix does not change the STORED hash at that position (nothing
  // recomputes downstream on an UPDATE), so the prefix check passes. What catches
  // it is `verifyChain`, which recomputes every link and finds the break.
  //
  // So the two are COMPLEMENTARY, and neither is sufficient alone:
  //   - verifyChain      catches edits, deletions, reordering — but is blind to a
  //                      self-consistent full-suffix rewrite (see THE POINT).
  //   - the receipt      catches exactly that rewrite — but only checks one
  //                      position, so it is blind to a sloppy in-prefix edit.
  //
  // Run BOTH. `pnpm proof` does.
  withDb((db) => {
    for (let i = 1; i <= 5; i++) record(db, i);
    const receipt = receiptNow(db);

    db.exec("UPDATE decisions SET chain_hash = 'chain_swapped' WHERE seq = 2");

    // The receipt alone: happy. Position 5 is untouched.
    assert.equal(
      check(db, receipt).consistent,
      true,
      "the receipt checks one position and is blind to this — that is why the chain exists",
    );

    // The chain: not happy.
    const chain = verifyChain(db);
    assert.equal(chain.valid, false, "the CHAIN is what catches an in-prefix edit");
    assert.ok(chain.defects.some((d) => d.kind === "broken_link" || d.kind === "broken_prev"));
  });
});

// ---------------------------------------------------------------------------
// Authenticity of the receipt itself.
// ---------------------------------------------------------------------------

test("a forged receipt is rejected — you cannot frame an honest operator", () => {
  // The signature's actual job. Without it, anyone could hand an auditor a
  // fabricated "receipt" and manufacture evidence of tampering that never
  // happened.
  withDb((db) => {
    for (let i = 1; i <= 3; i++) record(db, i);
    const real = receiptNow(db);
    const forged = {
      ...real,
      statement: { ...real.statement, head: "chain_fabricated", length: 2 },
    };
    const r = check(db, forged);
    assert.equal(r.consistent, false);
    assert.equal(r.code, "bad_signature", "a tampered statement must fail on the signature");
  });
});

test("a receipt signed by an untrusted key is rejected", () => {
  withDb((db) => {
    for (let i = 1; i <= 2; i++) record(db, i);
    const receipt = receiptNow(db);
    const r = verifyAgainstReceipt(db, receipt, new Map()); // empty keyring
    assert.equal(r.consistent, false);
    assert.equal(r.code, "bad_signature");
  });
});

test("verifyAgainstReceipt is TOTAL — hostile input is a verdict, never a throw", () => {
  withDb((db) => {
    record(db, 1);
    for (const hostile of [
      undefined,
      null,
      "",
      42,
      [],
      {},
      { statement: null, signature: {} },
      { statement: { head: 1, length: "x", at: 2 }, signature: {} },
      Object.create(null),
    ]) {
      assert.doesNotThrow(() => check(db, hostile));
      assert.equal(check(db, hostile).consistent, false);
    }
  });
});

test("the receipt is deterministic for a fixed chain and timestamp", () => {
  // Content-addressed publishing: the same chain at the same moment yields the
  // same receipt, so re-publishing cannot silently fork the witness trail.
  withDb((db) => {
    for (let i = 1; i <= 3; i++) record(db, i);
    assert.deepEqual(receiptNow(db), receiptNow(db));
  });
});

test("HONEST LIMIT: a compromised gate signs whatever it likes", () => {
  // Documented as an executable claim, not a comment. An attacker with the gate
  // key produces a valid receipt for their rewritten history. The signature is
  // NOT what makes this work — the auditor's COPY FROM BEFORE is. Signing only
  // stops a third party fabricating a receipt to frame an honest operator.
  withDb((db) => {
    for (let i = 1; i <= 3; i++) record(db, i);
    db.exec("DELETE FROM decisions WHERE seq >= 2");
    // The attacker re-publishes AFTER rewriting, with the real key.
    const attackersReceipt = receiptNow(db);
    assert.equal(
      check(db, attackersReceipt).consistent,
      true,
      "a receipt minted after the rewrite matches the rewrite — of course it does",
    );
    // Which is exactly why the receipt that matters is the one the auditor
    // already holds, published somewhere the operator cannot reach.
  });
});

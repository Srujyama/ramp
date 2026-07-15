/**
 * @ramp/ledger — chain.test.ts (RED TEAM)
 *
 * The chain's only value is what it CATCHES, so this file is mostly attacks.
 * Each one runs real SQL against a real seeded ledger — the same statements an
 * attacker with DB write access would run. Nothing is stubbed, because a stubbed
 * attack proves nothing about a real one.
 *
 * The load-bearing test is `RED TEAM: deleting a whole decision is now caught`.
 * Before chain.ts, that exact SQL left an audit trail where every remaining
 * proof verified perfectly. It was demonstrated against the seeded DB, and it is
 * why this file exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision, Facts, SpendRequest } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import type { LedgerDb } from "./db.js";
import { recordDecision } from "./decision-log.js";
import { buildProof } from "./proof.js";
import { verifyChain, chainHead, linkHash, GENESIS_CHAIN_HASH } from "./chain.js";

const REQ: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

const FACTS: Facts = {
  request_id: "inv_2026_07_0043",
  requesting_agent: "agent_47",
  amount: 340,
  vendor: "acme_corp",
  category: "office_supplies",
  vendor_verified: true,
  daily_total_so_far: 1140,
  per_txn_cap: 500,
  daily_limit: 1500,
  approved_categories: ["office_supplies", "software", "travel"],
  agent_cleared_categories: ["office_supplies", "software"],
  attestation_present: true,
};

const ALLOW: Decision = {
  decision: "allow",
  reasons: ["all_conditions_met"],
  firedRules: ["allow/all_conditions_met"],
};

const DENY: Decision = {
  decision: "deny",
  reasons: ["vendor_not_verified"],
  firedRules: ["deny/vendor_not_verified"],
};

/** Record N decisions, alternating allow/deny, each with a real proof. */
function seedChain(db: LedgerDb, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const decisionId = `dec_${String(i).padStart(3, "0")}`;
    const decision = i % 2 === 0 ? ALLOW : DENY;
    const proof = buildProof({
      decisionId,
      request: REQ,
      decision,
      facts: FACTS,
      kernelId: "ts-reference",
      attestation: { status: "verified" },
      producedAt: 1_770_000_000_000 + i,
    });
    recordDecision(db, { decisionId, request: REQ, facts: FACTS, decision, proof });
    ids.push(decisionId);
  }
  return ids;
}

function withDb<T>(fn: (db: LedgerDb) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

// ---------------------------------------------------------------------------
// The chain forms correctly.
// ---------------------------------------------------------------------------

test("an untouched chain verifies", () => {
  withDb((db) => {
    seedChain(db, 5);
    const v = verifyChain(db);
    assert.deepEqual(v.defects, []);
    assert.equal(v.valid, true);
    assert.equal(v.length, 5);
  });
});

test("an empty log is a valid chain at genesis", () => {
  withDb((db) => {
    const v = verifyChain(db);
    assert.equal(v.valid, true);
    assert.equal(v.length, 0);
    assert.equal(v.head, GENESIS_CHAIN_HASH);
  });
});

test("the head advances with every decision and commits to all of it", () => {
  withDb((db) => {
    const heads: string[] = [chainHead(db).head];
    for (let i = 1; i <= 3; i++) {
      seedChain(db, 0);
      const proof = buildProof({
        decisionId: `d${i}`,
        request: REQ,
        decision: ALLOW,
        facts: FACTS,
        producedAt: 1_770_000_000_000,
      });
      recordDecision(db, {
        decisionId: `d${i}`,
        request: REQ,
        facts: FACTS,
        decision: ALLOW,
        proof,
      });
      heads.push(chainHead(db).head);
    }
    // Every head is distinct: the chain moved.
    assert.equal(new Set(heads).size, heads.length);
    assert.equal(chainHead(db).length, 3);
  });
});

test("the first decision chains from genesis", () => {
  withDb((db) => {
    seedChain(db, 1);
    const row = db
      .prepare("SELECT prev_chain_hash AS p, seq FROM decisions WHERE seq = 1")
      .get() as { p: string; seq: number };
    assert.equal(row.p, GENESIS_CHAIN_HASH);
    assert.equal(row.seq, 1);
  });
});

// ---------------------------------------------------------------------------
// RED TEAM. Each of these was undetectable before chain.ts.
// ---------------------------------------------------------------------------

test("RED TEAM: deleting a whole decision is now caught", () => {
  withDb((db) => {
    const ids = seedChain(db, 5);
    // Before the chain, this exact SQL left every remaining proof verifying
    // perfectly — a clean audit trail with the inconvenient decision simply gone.
    const victim = ids[2]!;
    db.exec(`DELETE FROM decisions WHERE decision_id = '${victim}'`);

    const v = verifyChain(db);
    assert.equal(v.valid, false, "deleting a decision MUST be detectable");
    assert.equal(v.length, 4);
    // The gap is the tell: positions no longer count 1..N.
    assert.ok(v.defects.some((d) => d.kind === "gap"));
    // And the survivor's prev no longer matches its new predecessor.
    assert.ok(v.defects.some((d) => d.kind === "broken_prev"));
  });
});

test("RED TEAM: deleting the whole tail is caught by the published head", () => {
  withDb((db) => {
    seedChain(db, 5);
    const published = chainHead(db).head; // what an auditor saw yesterday

    // Truncate history. The REMAINING chain is internally perfect — 1..3 with
    // every link intact — so nothing internal can object.
    db.exec("DELETE FROM decisions WHERE seq > 3");

    const internal = verifyChain(db);
    assert.equal(internal.valid, true, "a truncated prefix is internally consistent");

    // Only the published head catches it. This is why chainHead() says PUBLISH THIS.
    const audited = verifyChain(db, published);
    assert.equal(audited.valid, false);
    assert.ok(audited.defects.some((d) => d.detail.includes("published head")));
  });
});

test("RED TEAM: reordering history is caught", () => {
  withDb((db) => {
    seedChain(db, 4);
    // Swap two positions — same rows, same proofs, different order.
    db.exec(`
      UPDATE decisions SET seq = 99 WHERE seq = 2;
      UPDATE decisions SET seq = 2  WHERE seq = 3;
      UPDATE decisions SET seq = 3  WHERE seq = 99;
    `);
    const v = verifyChain(db);
    assert.equal(v.valid, false, "reordering MUST be detectable");
    assert.ok(v.defects.some((d) => d.kind === "broken_prev"));
  });
});

test("RED TEAM: forging a row at an OCCUPIED position is refused by the DB", () => {
  withDb((db) => {
    seedChain(db, 3);
    // Stronger than "detected": the unique index on `seq` means a forged row at
    // an existing position never lands at all. Two rows claiming one slot is a
    // fork, not a log, so the database refuses to represent it.
    assert.throws(
      () =>
        db.exec(`
          INSERT INTO decisions
            (decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
             category, kernel_id, request_json, content_digest, seq,
             prev_chain_hash, chain_hash)
          VALUES ('forged', 'inv_forged', 'allowed', 'allow', 'agent_47', 'acme_corp',
                  99999, 'office_supplies', 'ts-reference', '{}', 'sha256:forged', 2,
                  'chain_forged_prev', 'chain_forged')
        `),
      /UNIQUE constraint failed: decisions\.seq/,
    );
    // And the chain is untouched.
    assert.equal(verifyChain(db).valid, true);
  });
});

test("RED TEAM: forging a row at a FREE position is caught by verifyChain", () => {
  withDb((db) => {
    seedChain(db, 3);
    // The unique index can't help here — position 9 is unoccupied. The attacker
    // appends a plausible-looking decision past the head.
    db.exec(`
      INSERT INTO decisions
        (decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
         category, kernel_id, request_json, content_digest, seq,
         prev_chain_hash, chain_hash)
      VALUES ('forged', 'inv_forged', 'allowed', 'allow', 'agent_47', 'acme_corp',
              99999, 'office_supplies', 'ts-reference', '{}', 'sha256:forged', 9,
              'chain_forged_prev', 'chain_forged')
    `);
    const v = verifyChain(db);
    assert.equal(v.valid, false, "a forged decision MUST be detectable");
    // Two independent tells: the position jumps, and its prev doesn't chain.
    assert.ok(v.defects.some((d) => d.kind === "gap"));
    assert.ok(v.defects.some((d) => d.kind === "broken_prev"));
  });
});

test("RED TEAM: swapping a decision's proof breaks its link", () => {
  withDb((db) => {
    const ids = seedChain(db, 3);
    // The row stays, the position stays — only the proof it commits to changes.
    db.exec(
      `UPDATE decision_proofs SET proof_id = 'proof_swapped' WHERE decision_id = '${ids[1]}'`,
    );
    const v = verifyChain(db);
    assert.equal(v.valid, false, "the chain must commit to CONTENT, not just position");
    assert.ok(v.defects.some((d) => d.kind === "broken_link"));
  });
});

test("RED TEAM: rewriting one link to hide a deletion still breaks the next one", () => {
  withDb((db) => {
    const ids = seedChain(db, 5);
    // A smarter attacker: delete a row AND patch the survivor's prev to match.
    const head2 = db
      .prepare("SELECT chain_hash AS h FROM decisions WHERE seq = 2")
      .get() as { h: string };
    db.exec(`DELETE FROM decisions WHERE decision_id = '${ids[2]}'`);
    db.exec(
      `UPDATE decisions SET prev_chain_hash = '${head2.h}', seq = 3 WHERE decision_id = '${ids[3]}'`,
    );

    const v = verifyChain(db);
    // The patched row's OWN chain_hash no longer matches H(prev || proof), because
    // chain_hash was computed over the ORIGINAL prev. To hide the deletion the
    // attacker must recompute every link to the head — i.e. rewrite the suffix,
    // which the published head catches.
    assert.equal(v.valid, false);
    assert.ok(v.defects.some((d) => d.kind === "broken_link" || d.kind === "broken_prev"));
  });
});

test("every defect is reported, not just the first", () => {
  withDb((db) => {
    const ids = seedChain(db, 6);
    db.exec(`DELETE FROM decisions WHERE decision_id IN ('${ids[1]}', '${ids[3]}')`);
    const v = verifyChain(db);
    assert.equal(v.valid, false);
    assert.ok(v.defects.length >= 2, "an auditor wants the shape of the damage");
  });
});

// ---------------------------------------------------------------------------
// Honesty about what the chain does NOT claim.
// ---------------------------------------------------------------------------

test("the chain says nothing about whether a decision was CORRECT", () => {
  withDb((db) => {
    // A deliberately WRONG decision: facts that plainly deny, recorded as allow.
    const wrongFacts: Facts = { ...FACTS, vendor_verified: false };
    const proof = buildProof({
      decisionId: "wrong",
      request: REQ,
      decision: ALLOW, // <- a lie
      facts: wrongFacts,
      producedAt: 1_770_000_000_000,
    });
    recordDecision(db, {
      decisionId: "wrong",
      request: REQ,
      facts: wrongFacts,
      decision: ALLOW,
      proof,
    });

    // The chain is perfectly happy. It is not its job, and pretending otherwise
    // would be the exact overclaim this repo exists to avoid: integrity, chain
    // integrity, and soundness are three different guarantees. Catching THIS is
    // @ramp/provenance's verifyBundle, which re-runs the kernel.
    const v = verifyChain(db);
    assert.equal(v.valid, true, "chain integrity != soundness — by design");
  });
});

test("a pre-chain row (NULL seq) is skipped, not fabricated a link", () => {
  withDb((db) => {
    seedChain(db, 2);
    // Simulate a row written before the chain existed.
    db.exec(`
      INSERT INTO decisions
        (decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
         category, kernel_id, request_json, content_digest)
      VALUES ('legacy', 'inv_legacy', 'allowed', 'allow', 'agent_47', 'acme_corp',
              10, 'office_supplies', 'ts-reference', '{}', 'sha256:legacy')
    `);
    // It has no link, so it is not part of the chain — and we do NOT invent one.
    // Back-filling a plausible link would be fabricating history we cannot vouch
    // for, which is precisely the lie the chain exists to detect.
    const v = verifyChain(db);
    assert.equal(v.valid, true);
    assert.equal(v.length, 2, "the legacy row is excluded, not fabricated into the chain");
  });
});

test("linkHash depends on prev AND proof AND decision id", () => {
  const base = linkHash("prev1", "proof1", "d1");
  assert.notEqual(base, linkHash("prev2", "proof1", "d1"), "prev must matter (ordering)");
  assert.notEqual(base, linkHash("prev1", "proof2", "d1"), "proof must matter (content)");
  assert.notEqual(base, linkHash("prev1", "proof1", "d2"), "decision id must matter");
  assert.equal(base, linkHash("prev1", "proof1", "d1"), "and it must be deterministic");
});

test("an error row with no proof still occupies an unforgeable position", () => {
  withDb((db) => {
    seedChain(db, 1);
    // Infra error rows carry no proof. They must still take a chain slot, or they
    // are a hole an attacker can fill without breaking anything.
    recordDecision(db, { decisionId: "err_1", request: REQ, status: "error" });
    const v = verifyChain(db);
    assert.equal(v.valid, true);
    assert.equal(v.length, 2, "the error row is chained too");
  });
});

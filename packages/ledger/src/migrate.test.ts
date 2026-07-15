/**
 * @ramp/ledger — migrate.test.ts
 *
 * The CHECK-widening migration rebuilds `decisions`, and `decision_proofs` /
 * `decision_fired_rules` reference it `ON DELETE CASCADE`. Get the pragma
 * ordering wrong and the migration ERASES THE ENTIRE PROOF HISTORY — silently,
 * in the table whose whole job is being tamper-evident.
 *
 * These tests exist so that stays a hypothetical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLedger, closeLedger } from "./db.js";
import { migrateDecisionsChecks } from "./migrate.js";
import { verifyChain } from "./chain.js";

/**
 * Build a ledger with the OLD, pre-escalate CHECK constraints and some history.
 * Hand-rolled rather than opened via `openLedger`, because openLedger now
 * migrates on open — the thing under test would run before we could test it.
 */
function makeLegacyLedger(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE decisions (
      decision_id         TEXT PRIMARY KEY,
      request_id          TEXT NOT NULL,
      status              TEXT NOT NULL CHECK (status IN ('allowed', 'denied', 'error')),
      outcome             TEXT CHECK (outcome IN ('allow', 'deny')),
      agent_id            TEXT NOT NULL,
      vendor_id           TEXT NOT NULL,
      amount              INTEGER NOT NULL,
      category            TEXT NOT NULL,
      attestation_present INTEGER CHECK (attestation_present IN (0, 1)),
      kernel_id           TEXT,
      request_json        TEXT NOT NULL,
      facts_json          TEXT,
      decision_json       TEXT,
      content_digest      TEXT NOT NULL,
      seq                 INTEGER,
      prev_chain_hash     TEXT,
      chain_hash          TEXT,
      ts                  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE decision_proofs (
      decision_id        TEXT PRIMARY KEY REFERENCES decisions(decision_id) ON DELETE CASCADE,
      proof_id           TEXT NOT NULL,
      proof_schema       TEXT NOT NULL,
      attestation_status TEXT NOT NULL,
      proof_json         TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE decision_fired_rules (
      decision_id TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,
      ord         INTEGER NOT NULL,
      rule_id     TEXT NOT NULL,
      PRIMARY KEY (decision_id, ord)
    );
  `);
  for (let i = 1; i <= 3; i++) {
    db.exec(`
      INSERT INTO decisions (decision_id, request_id, status, outcome, agent_id,
        vendor_id, amount, category, request_json, content_digest, seq,
        prev_chain_hash, chain_hash)
      VALUES ('d${i}', 'r${i}', 'allowed', 'allow', 'agent_47', 'acme_corp', 100,
              'office_supplies', '{}', 'sha256:d${i}', ${i}, 'prev${i}', 'chain${i}');
      INSERT INTO decision_proofs (decision_id, proof_id, proof_schema, attestation_status, proof_json)
      VALUES ('d${i}', 'proof_${i}', 'ramp/ledger-proof-v1', 'verified', '{}');
      INSERT INTO decision_fired_rules (decision_id, ord, rule_id)
      VALUES ('d${i}', 0, 'allow/all_conditions_met');
    `);
  }
  return db;
}

function withLegacy<T>(fn: (db: DatabaseSync, path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ramp-migrate-"));
  const path = join(dir, "legacy.db");
  const db = makeLegacyLedger(path);
  try {
    return fn(db, path);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test("a legacy ledger genuinely rejects an escalated decision", () => {
  // The premise. If this ever stops throwing, the migration is unnecessary and
  // this whole file should go.
  withLegacy((db) => {
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO decisions (decision_id,request_id,status,outcome,agent_id,vendor_id,amount,category,request_json,content_digest)
           VALUES ('x','y','escalated','escalate','a','v',1,'c','{}','d')`,
        ),
      /CHECK constraint failed/,
    );
  });
});

test("THE FOOTGUN: migrating does NOT cascade-delete proofs or fired rules", () => {
  // `DROP TABLE decisions` with foreign_keys ON erases every dependent row. This
  // is the test that catches a careless edit to the pragma ordering in migrate.ts.
  withLegacy((db) => {
    assert.equal(count(db, "decision_proofs"), 3);
    assert.equal(count(db, "decision_fired_rules"), 3);

    const migrated = migrateDecisionsChecks(db);
    assert.equal(migrated, true);

    assert.equal(count(db, "decisions"), 3, "no decision may be lost");
    assert.equal(count(db, "decision_proofs"), 3, "PROOFS MUST SURVIVE THE REBUILD");
    assert.equal(count(db, "decision_fired_rules"), 3, "fired rules must survive");
  });
});

test("migrating preserves every column value, not just the row count", () => {
  withLegacy((db) => {
    const before = db.prepare("SELECT * FROM decisions ORDER BY seq").all();
    migrateDecisionsChecks(db);
    const after = db.prepare("SELECT * FROM decisions ORDER BY seq").all();
    assert.deepEqual(after, before, "a migration must not alter a single stored value");
  });
});

test("the hash chain still verifies after the rebuild", () => {
  // The chain commits to proof ids; if the rebuild dropped or reordered rows the
  // chain is the thing that notices. Belt and braces on the row counts above.
  withLegacy((db, path) => {
    migrateDecisionsChecks(db);
    db.close();
    const reopened = openLedger(path, { provisionIfEmpty: false });
    try {
      // These legacy rows have hand-made chain hashes, so we only assert the
      // walk finds all three in order — the real chain test covers the maths.
      assert.equal(verifyChain(reopened).length, 3);
    } finally {
      closeLedger(reopened);
    }
  });
});

test("after migrating, an escalated decision is accepted", () => {
  withLegacy((db) => {
    migrateDecisionsChecks(db);
    assert.doesNotThrow(() =>
      db.exec(
        `INSERT INTO decisions (decision_id,request_id,status,outcome,agent_id,vendor_id,amount,category,request_json,content_digest)
         VALUES ('esc','y','escalated','escalate','a','v',1,'c','{}','d')`,
      ),
    );
    assert.equal(count(db, "decisions"), 4);
  });
});

test("the migration is idempotent — a second run is a no-op", () => {
  withLegacy((db) => {
    assert.equal(migrateDecisionsChecks(db), true, "first run migrates");
    assert.equal(migrateDecisionsChecks(db), false, "second run is a no-op");
    assert.equal(migrateDecisionsChecks(db), false, "and stays a no-op");
    assert.equal(count(db, "decision_proofs"), 3, "repeated runs must not erode data");
  });
});

test("foreign keys are ON again afterwards", () => {
  // The migration turns them OFF to survive the drop. Leaving them off would
  // silently disable referential integrity for the rest of the process — a much
  // quieter bug than the one it was working around.
  withLegacy((db) => {
    migrateDecisionsChecks(db);
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(fk.foreign_keys, 1, "foreign_keys must be restored after the rebuild");
  });
});

test("the seq unique index survives the rebuild", () => {
  // The index belonged to the dropped table. If it isn't recreated, two rows can
  // claim one chain position — a fork, which the chain is supposed to make
  // unrepresentable.
  withLegacy((db) => {
    migrateDecisionsChecks(db);
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO decisions (decision_id,request_id,status,outcome,agent_id,vendor_id,amount,category,request_json,content_digest,seq)
           VALUES ('dup','y','allowed','allow','a','v',1,'c','{}','d',1)`,
        ),
      /UNIQUE constraint failed/,
    );
  });
});

test("openLedger migrates on open, so nothing has to remember to", () => {
  withLegacy((db, path) => {
    db.close();
    const reopened = openLedger(path);
    try {
      assert.doesNotThrow(() =>
        reopened.exec(
          `INSERT INTO decisions (decision_id,request_id,status,outcome,agent_id,vendor_id,amount,category,request_json,content_digest)
           VALUES ('esc2','y','escalated','escalate','a','v',1,'c','{}','d')`,
        ),
      );
    } finally {
      closeLedger(reopened);
    }
  });
});

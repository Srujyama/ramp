/**
 * @ramp/ledger — decision-log-proof.test.ts
 *
 * New behaviours layered onto the audit trail: content-checked idempotency
 * (exact duplicate absorbed, conflicting duplicate REJECTED — never overwritten),
 * atomic proof persistence, no-proof rows still readable, and corrupt-proof
 * detection. Complements decision-log.test.ts (left untouched). Run `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import {
  recordDecision,
  getDecision,
  DecisionConflictError,
} from "./decision-log.js";
import { buildProof, verifyProof } from "./proof.js";

const req: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

function facts(over: Partial<Facts> = {}): Facts {
  return {
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
    attestation_present: false,
    ...over,
  };
}

const ALLOW: Decision = {
  decision: "allow",
  reasons: ["allow: every policy condition held"],
  firedRules: ["allow/all_conditions_met"],
};

const DENY: Decision = {
  decision: "deny",
  reasons: ["denied: deny/over_per_txn_cap"],
  firedRules: ["deny/over_per_txn_cap"],
};

function withDb<T>(fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

// --- content-checked idempotency --------------------------------------------

test("exact duplicate (same id, same content) is an idempotent no-op", () => {
  withDb((db) => {
    const id = "dec_exact";
    const first = recordDecision(db, {
      decisionId: id,
      request: req,
      facts: facts(),
      decision: ALLOW,
    });
    const second = recordDecision(db, {
      decisionId: id,
      request: req,
      facts: facts(),
      decision: ALLOW,
    });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false); // absorbed, not thrown

    // A different ts must NOT count as a conflict (ts is excluded from the digest).
    const third = recordDecision(db, {
      decisionId: id,
      request: req,
      facts: facts(),
      decision: ALLOW,
      ts: "2030-01-01 00:00:00",
    });
    assert.equal(third.inserted, false);
  });
});

test("conflicting duplicate (same id, different content) is REJECTED, not overwritten", () => {
  withDb((db) => {
    const id = "dec_conflict";
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW });

    // Same id, different decision → conflict.
    assert.throws(
      () =>
        recordDecision(db, {
          decisionId: id,
          request: req,
          facts: facts(),
          decision: DENY,
        }),
      (e: unknown) => e instanceof DecisionConflictError,
    );

    // Same id, different request amount → also conflict.
    assert.throws(
      () =>
        recordDecision(db, {
          decisionId: id,
          request: { ...req, amount: 999 },
          facts: facts(),
          decision: ALLOW,
        }),
      (e: unknown) => e instanceof DecisionConflictError,
    );

    // Original row is intact (allow preserved, never clobbered).
    const rec = getDecision(db, id);
    assert.equal(rec?.outcome, "allow");
    assert.equal(rec?.decision?.decision, "allow");
  });
});

// --- proof persistence -------------------------------------------------------

test("a proof is persisted atomically and read back valid", () => {
  withDb((db) => {
    const id = "dec_proof";
    const proof = buildProof({
      decisionId: id,
      request: req,
      decision: ALLOW,
      facts: facts(),
      kernelId: "ts-reference",
      attestation: { status: "present_unverified" },
      producedAt: 1_700_000_000_000,
    });
    const res = recordDecision(db, {
      decisionId: id,
      request: req,
      facts: facts(),
      decision: ALLOW,
      proof,
    });
    assert.equal(res.inserted, true);

    const rec = getDecision(db, id);
    assert.ok(rec?.proof, "proof should be present");
    assert.equal(rec.proof.proofId, proof.proofId);
    assert.equal(rec.corrupt, false);
    assert.equal(verifyProof(rec.proof).valid, true);
  });
});

test("decisions WITHOUT a proof remain readable (proof null, not corrupt)", () => {
  withDb((db) => {
    const id = "dec_noproof";
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW });
    const rec = getDecision(db, id);
    assert.equal(rec?.proof, null);
    assert.equal(rec?.corrupt, false);
  });
});

test("re-delivering a decision with a CONFLICTING proof fails explicitly", () => {
  withDb((db) => {
    const id = "dec_proofconflict";
    const proofA = buildProof({
      decisionId: id,
      request: req,
      decision: ALLOW,
      producedAt: 1,
      attestation: { status: "present_unverified" },
    });
    const proofB = buildProof({
      decisionId: id,
      request: req,
      decision: ALLOW,
      producedAt: 1,
      attestation: { status: "verified" }, // different attestation → different proofId
    });
    assert.notEqual(proofA.proofId, proofB.proofId);

    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof: proofA });
    assert.throws(
      () =>
        recordDecision(db, {
          decisionId: id,
          request: req,
          facts: facts(),
          decision: ALLOW,
          proof: proofB,
        }),
      (e: unknown) => e instanceof DecisionConflictError,
    );
    // Original proof intact.
    assert.equal(getDecision(db, id)?.proof?.proofId, proofA.proofId);
  });
});

test("re-delivering the SAME decision + SAME proof is idempotent", () => {
  withDb((db) => {
    const id = "dec_proofsame";
    const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
    const first = recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });
    const second = recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
  });
});

test("a mislinked proof throws and writes NOTHING (atomic: no partial row)", () => {
  withDb((db) => {
    const id = "dec_mislink";
    const proof = buildProof({ decisionId: "some_other_id", request: req, decision: ALLOW, producedAt: 1 });
    assert.throws(
      () =>
        recordDecision(db, {
          decisionId: id,
          request: req,
          facts: facts(),
          decision: ALLOW,
          proof,
        }),
      /does not match/,
    );
    // The decision row must NOT exist — the guard runs before any write.
    assert.equal(getDecision(db, id), undefined);
  });
});

test("a corrupt stored proof blob is flagged (proof null, corrupt true)", () => {
  withDb((db) => {
    const id = "dec_corruptproof";
    const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });

    // Tamper the stored JSON out-of-band.
    db.prepare("UPDATE decision_proofs SET proof_json = ? WHERE decision_id = ?").run(
      "{ not valid json",
      id,
    );
    const rec = getDecision(db, id);
    assert.equal(rec?.proof, null);
    assert.equal(rec?.corrupt, true); // distinguishes corrupt from a genuine no-proof row
  });
});

/**
 * @ramp/ledger — proof-verification.test.ts
 *
 * Independent re-verification of stored proofs (never trusting the stored bytes)
 * and the read-only `verify-proof` CLI exit-code mapping. Run `node --test`.
 *
 * Covered:
 *   - verifyDecisionProof: valid → ok, tampered → mismatch, missing → absent,
 *     corrupt (recompute throws) → corrupt (no throw).
 *   - CLI core exit codes: ok(0), missing-proof(4), corrupt(5), mismatch(6),
 *     not-found(3) — all without spawning a process or calling process.exit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import { recordDecision, getDecision, type DecisionRecord } from "./decision-log.js";
import { buildProof, type LedgerProof } from "./proof.js";
import { verifyDecisionProof } from "./proof-verification.js";
import {
  runVerifyProof,
  verifyProofResultFor,
  EXIT_OK,
  EXIT_NOT_FOUND,
  EXIT_MISSING_PROOF,
  EXIT_CORRUPT,
  EXIT_MISMATCH,
} from "./cli/verify-proof.js";

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
    escalation_threshold: 400,
    vendor_risk_tier: "standard",
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: 6,
    duplicate_recent_count: 0,
    ...over,
  };
}

const ALLOW: Decision = {
  decision: "allow",
  reasons: ["allow: every policy condition held"],
  firedRules: ["allow/all_conditions_met"],
};

function withDb<T>(fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

// --- verifyDecisionProof (the helper) ---------------------------------------

test("valid proof → proofVerified true, reason ok", () => {
  withDb((db) => {
    const id = "dec_valid";
    const proof = buildProof({
      decisionId: id,
      request: req,
      decision: ALLOW,
      facts: facts(),
      kernelId: "ts-reference",
      producedAt: 1_700_000_000_000,
    });
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });

    const rec = getDecision(db, id);
    assert.ok(rec, "decision should exist");
    const v = verifyDecisionProof(rec);
    assert.equal(v.proofPresent, true);
    assert.equal(v.proofVerified, true);
    assert.equal(v.reason, "ok");
    assert.equal(v.actualProofId, proof.proofId);
    assert.equal(v.expectedProofId, proof.proofId);
  });
});

test("tampered proof → proofVerified false, reason mismatch (no DB needed)", () => {
  const id = "dec_tamper";
  const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
  // Mutate meaningful content while leaving the stored proofId in place: the
  // recomputed id no longer matches the (stale) stored id.
  const tampered: LedgerProof = { ...proof, requestDigest: "sha256:deadbeef" };
  assert.notEqual(tampered.requestDigest, proof.requestDigest);

  const v = verifyDecisionProof({ proof: tampered });
  assert.equal(v.proofPresent, true);
  assert.equal(v.proofVerified, false);
  assert.equal(v.reason, "mismatch");
  assert.equal(v.actualProofId, proof.proofId); // stored id unchanged
  assert.notEqual(v.expectedProofId, proof.proofId); // recomputed differs
});

test("missing proof → proofPresent false, proofVerified false, reason absent", () => {
  const v = verifyDecisionProof({ proof: null });
  assert.equal(v.proofPresent, false);
  assert.equal(v.proofVerified, false);
  assert.equal(v.reason, "absent");
  assert.equal(v.expectedProofId, null);
  assert.equal(v.actualProofId, null);
});

test("corrupt proof (recompute throws) → reason corrupt, no throw, stored id preserved", () => {
  const id = "dec_corrupt";
  const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
  // A non-finite number in a non-volatile nested field makes canonicalize (inside
  // verifyProof) throw. proofId stays readable. Cast through unknown: this shape
  // cannot exist after a JSON round-trip, so we forge it directly.
  const corrupt = {
    ...proof,
    decision: { ...ALLOW, _poison: Number.NaN },
  } as unknown as LedgerProof;

  let v: ReturnType<typeof verifyDecisionProof> | undefined;
  assert.doesNotThrow(() => {
    v = verifyDecisionProof({ proof: corrupt });
  });
  assert.ok(v);
  assert.equal(v.proofPresent, true);
  assert.equal(v.proofVerified, false);
  assert.equal(v.reason, "corrupt");
  assert.equal(v.expectedProofId, null);
  assert.equal(v.actualProofId, proof.proofId); // readable stored id surfaced
});

test("a missing proof is NEVER reported as verified", () => {
  const v = verifyDecisionProof({ proof: null });
  assert.equal(v.proofVerified, false);
});

// --- CLI core exit-code mapping (no process spawned, no process.exit) --------

test("CLI: ok → exit 0", () => {
  withDb((db) => {
    const id = "cli_ok";
    const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });
    const run = runVerifyProof({ db, decisionId: id });
    assert.equal(run.code, EXIT_OK);
    assert.equal(run.err.length, 0);
    assert.ok(run.out.some((l) => l.includes("proofVerified: true")));
  });
});

test("CLI: decision without a proof → missing-proof exit 4", () => {
  withDb((db) => {
    const id = "cli_noproof";
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW });
    const run = runVerifyProof({ db, decisionId: id });
    assert.equal(run.code, EXIT_MISSING_PROOF);
    assert.ok(run.out.some((l) => l.includes("proof present: false")));
  });
});

test("CLI: tampered stored proof → mismatch exit 6", () => {
  withDb((db) => {
    const id = "cli_mismatch";
    const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
    recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });

    // Out-of-band tamper: overwrite the stored proof with a SHAPE-VALID proof whose
    // content differs but whose proofId is unchanged → recompute mismatches.
    const tampered: LedgerProof = { ...proof, requestDigest: "sha256:deadbeef" };
    db.prepare("UPDATE decision_proofs SET proof_json = ? WHERE decision_id = ?").run(
      JSON.stringify(tampered),
      id,
    );

    const run = runVerifyProof({ db, decisionId: id });
    assert.equal(run.code, EXIT_MISMATCH);
    assert.ok(run.out.some((l) => l.includes("reason:        mismatch")));
  });
});

test("CLI: unknown decision → not-found exit 3 (stderr, no throw)", () => {
  withDb((db) => {
    const run = runVerifyProof({ db, decisionId: "does_not_exist" });
    assert.equal(run.code, EXIT_NOT_FOUND);
    assert.equal(run.out.length, 0);
    assert.ok(run.err.some((l) => l.includes("decision not found: does_not_exist")));
  });
});

test("CLI: corrupt proof (recompute throws) → corrupt exit 5", () => {
  // A JSON round-trip cannot preserve a NaN, so drive the mapping through the pure
  // core with a forged record whose present proof makes verifyProof throw.
  const proof = buildProof({ decisionId: "cli_corrupt", request: req, decision: ALLOW, producedAt: 1 });
  const corruptRecord = {
    decisionId: "cli_corrupt",
    status: "allowed",
    outcome: "allow",
    corrupt: false,
    proof: { ...proof, decision: { ...ALLOW, _poison: Number.NaN } },
  } as unknown as DecisionRecord;

  const run = verifyProofResultFor(corruptRecord, "cli_corrupt");
  assert.equal(run.code, EXIT_CORRUPT);
  assert.ok(run.out.some((l) => l.includes("reason:        corrupt")));
});

test("CLI: verifyProofResultFor(undefined) → not-found exit 3", () => {
  const run = verifyProofResultFor(undefined, "ghost");
  assert.equal(run.code, EXIT_NOT_FOUND);
  assert.ok(run.err.some((l) => l.includes("decision not found: ghost")));
});

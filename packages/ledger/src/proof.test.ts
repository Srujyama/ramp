/**
 * @ramp/ledger — proof.test.ts
 *
 * Proof id determinism, volatile-field independence, tamper-sensitivity for every
 * meaningful field, verifyProof integrity, attestation-state handling, and
 * provenance validation before build. Run with `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import {
  buildProof,
  verifyProof,
  isLedgerProofShape,
  PROOF_SCHEMA,
  type BuildProofInput,
  type LedgerProof,
} from "./proof.js";
import { ProvenanceError, type ProvenanceGraph } from "./provenance.js";

const req: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

const facts: Facts = {
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
  agent_identity_verified: true,
escalation_threshold: 400,
vendor_risk_tier: "standard",
budgets: [],
recent_txn_count: 0,
velocity_limit: 6,
duplicate_recent_count: 0,
};

const decision: Decision = {
  decision: "allow",
  reasons: ["allow: every policy condition held"],
  firedRules: ["allow/all_conditions_met"],
};

/** A fully-populated proof input with a FIXED producedAt for determinism. */
function base(over: Partial<BuildProofInput> = {}): BuildProofInput {
  return {
    decisionId: "dec_1",
    request: req,
    decision,
    facts,
    policyDigest: "sha256:policy",
    kernelId: "ts-reference",
    kernelVersion: "1.0.0",
    attestation: { status: "present_unverified", provider: "tlsnotary" },
    producedAt: 1_700_000_000_000,
    latencyMs: 3,
    ...over,
  };
}

test("proof has the versioned schema + a proof_<hex> id", () => {
  const p = buildProof(base());
  assert.equal(p.schema, PROOF_SCHEMA);
  assert.match(p.proofId, /^proof_[0-9a-f]{64}$/);
});

test("buildProof is deterministic for identical input", () => {
  assert.equal(buildProof(base()).proofId, buildProof(base()).proofId);
});

test("proofId is INDEPENDENT of volatile producedAt / latencyMs", () => {
  const a = buildProof(base({ producedAt: 1, latencyMs: 0 }));
  const b = buildProof(base({ producedAt: 999_999, latencyMs: 5000 }));
  assert.equal(a.proofId, b.proofId);
});

test("every meaningful field change moves the proofId", () => {
  const id = (i: BuildProofInput) => buildProof(i).proofId;
  const baseline = id(base());

  assert.notEqual(baseline, id(base({ request: { ...req, amount: 341 } })));
  assert.notEqual(baseline, id(base({ facts: { ...facts, daily_total_so_far: 0 } })));
  assert.notEqual(
    baseline,
    id(base({ decision: { ...decision, decision: "deny" } })),
  );
  assert.notEqual(baseline, id(base({ policyDigest: "sha256:other" })));
  assert.notEqual(baseline, id(base({ kernelId: "wasm" })));
  assert.notEqual(baseline, id(base({ kernelVersion: "2.0.0" })));
  assert.notEqual(
    baseline,
    id(base({ attestation: { status: "verified", provider: "tlsnotary" } })),
  );
  assert.notEqual(baseline, id(base({ decisionId: "dec_2" })));
});

test("fired-rule ORDER changes the proofId", () => {
  const d1: Decision = {
    decision: "deny",
    reasons: ["a", "b"],
    firedRules: ["deny/vendor_not_verified", "deny/over_per_txn_cap"],
  };
  const d2: Decision = {
    decision: "deny",
    reasons: ["a", "b"],
    firedRules: ["deny/over_per_txn_cap", "deny/vendor_not_verified"],
  };
  assert.notEqual(
    buildProof(base({ decision: d1 })).proofId,
    buildProof(base({ decision: d2 })).proofId,
  );
});

test("attaching / changing provenance changes the proofId", () => {
  const prov: ProvenanceGraph = {
    nodes: [{ id: "t", kind: "task" }, { id: "a", kind: "tool_call" }],
    edges: [{ parent: "t", child: "a" }],
  };
  const withProv = buildProof(base({ provenance: prov }));
  assert.notEqual(buildProof(base()).proofId, withProv.proofId);
  assert.deepEqual(withProv.provenance, prov);
});

test("facts absent → factsDigest null, and still hashes", () => {
  const p = buildProof(base({ facts: undefined }));
  assert.equal(p.factsDigest, null);
  assert.match(p.requestDigest, /^sha256:[0-9a-f]{64}$/);
});

test("missing policy/kernel/attestation recorded honestly, not fabricated", () => {
  const p = buildProof({ decisionId: "d", request: req, decision });
  assert.equal(p.policyDigest, null);
  assert.equal(p.kernelId, null);
  assert.equal(p.attestationStatus, "absent");
  assert.equal(p.attestationProvider, null);
  assert.equal(p.provenance, null);
});

test("verifyProof accepts an untampered proof", () => {
  const p = buildProof(base());
  const v = verifyProof(p);
  assert.equal(v.valid, true);
  assert.equal(v.expectedProofId, v.actualProofId);
});

test("verifyProof rejects a tampered proof (id no longer matches content)", () => {
  const p = buildProof(base());
  // Tamper: flip the outcome but keep the old proofId.
  const tampered: LedgerProof = {
    ...p,
    decision: { ...p.decision, decision: "deny" },
  };
  const v = verifyProof(tampered);
  assert.equal(v.valid, false);
  assert.notEqual(v.expectedProofId, v.actualProofId);
});

test("buildProof validates provenance and rejects an invalid graph", () => {
  const cyclic: ProvenanceGraph = {
    nodes: [{ id: "a", kind: "task" }, { id: "b", kind: "tool_call" }],
    edges: [{ parent: "a", child: "b" }, { parent: "b", child: "a" }],
  };
  assert.throws(
    () => buildProof(base({ provenance: cyclic })),
    (e: unknown) => e instanceof ProvenanceError && e.kind === "cycle",
  );
});

test("isLedgerProofShape accepts a real proof and rejects junk", () => {
  assert.ok(isLedgerProofShape(buildProof(base())));
  assert.equal(isLedgerProofShape({ schema: "wrong" }), false);
  assert.equal(isLedgerProofShape(null), false);
  assert.equal(isLedgerProofShape({}), false);
});

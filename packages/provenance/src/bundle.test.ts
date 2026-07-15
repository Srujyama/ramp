/**
 * @ramp/provenance — tests
 *
 * The verifier's whole value is what it REFUSES, so most of this file doctors
 * bundles and asserts they're caught. A verifier that only recognises honest
 * bundles proves exactly nothing.
 *
 * These tests deliberately use a local kernel that mirrors @ramp/gate's
 * ReferenceKernel rather than importing it: @ramp/provenance must not depend on
 * @ramp/gate (the gate is a CONSUMER of bundles), and an auditor supplies their
 * own kernel anyway — which is precisely the point of the design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, type Decision, type Facts, type PolicyKernel } from "@ramp/shared";
import {
  buildBundle,
  verifyBundle,
  digestFacts,
  BUNDLE_VERSION,
  type DecisionBundle,
  type FactProvenance,
} from "./bundle.js";
import { renderBundle, summarizeBundle } from "./render.js";

/**
 * A minimal kernel mirroring policy.dl's deny rules, in the frozen order.
 * Deny dominates.
 */
const kernel: PolicyKernel = {
  evaluate(f: Facts): Decision {
    const denies: Array<[string, string]> = [];
    if (!f.vendor_verified)
      denies.push(["deny/vendor_not_verified", `vendor_not_verified: "${f.vendor}"`]);
    if (f.amount > f.per_txn_cap)
      denies.push(["deny/over_per_txn_cap", `over_per_txn_cap: ${f.amount} > ${f.per_txn_cap}`]);
    if (!f.approved_categories.includes(f.category))
      denies.push(["deny/category_not_approved", `category_not_approved: "${f.category}"`]);
    if (!f.agent_cleared_categories.includes(f.category))
      denies.push([
        "deny/agent_uncleared_for_category",
        `agent_uncleared_for_category: "${f.requesting_agent}"`,
      ]);
    if (f.daily_total_so_far + f.amount > f.daily_limit)
      denies.push([
        "deny/daily_limit_exceeded",
        `daily_limit_exceeded: ${f.daily_total_so_far} + ${f.amount} > ${f.daily_limit}`,
      ]);

    if (denies.length > 0) {
      return {
        decision: "deny",
        reasons: denies.map(([, r]) => r),
        firedRules: denies.map(([id]) => id) as Decision["firedRules"],
      };
    }
    return {
      decision: "allow",
      reasons: ["all_conditions_met"],
      firedRules: ["allow/all_conditions_met"],
    };
  },
};

/** The hero facts from PITCH.md demo beat 1: 1140 + 340 <= 1500 -> allow. */
const HERO_FACTS: Facts = {
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

/** Complete, honest provenance for HERO_FACTS — one entry per Facts field. */
function heroProvenance(facts: Facts = HERO_FACTS): FactProvenance[] {
  return [
    { fact: "request_id", value: facts.request_id, source: "tool_args", derivation: { kind: "declassified", contentId: "q_abc123", declassifier: "asIdentifier", codomain: "/^[A-Za-z0-9_-]{1,64}$/", admitted: true } },
    { fact: "requesting_agent", value: facts.requesting_agent, source: "tool_args", derivation: { kind: "structured_arg", field: "requestingAgent" } },
    { fact: "amount", value: facts.amount, source: "tool_args", derivation: { kind: "structured_arg", field: "amount" } },
    { fact: "vendor", value: facts.vendor, source: "tool_args", derivation: { kind: "structured_arg", field: "vendorId" } },
    { fact: "category", value: facts.category, source: "tool_args", derivation: { kind: "structured_arg", field: "category" } },
    { fact: "vendor_verified", value: facts.vendor_verified, source: "vendor_registry", derivation: { kind: "sql", table: "vendors", query: "SELECT verified FROM vendors WHERE vendor_id = ?", params: ["acme_corp"] } },
    { fact: "daily_total_so_far", value: facts.daily_total_so_far, source: "ledger_db", derivation: { kind: "sql", table: "ledger_entries", query: "SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE agent_id = ? AND date(ts) = date('now')", params: ["agent_47"] } },
    { fact: "per_txn_cap", value: facts.per_txn_cap, source: "policy_config", derivation: { kind: "sql", table: "policy_limits", query: "SELECT per_txn_cap FROM policy_limits WHERE id = 1", params: [] } },
    { fact: "daily_limit", value: facts.daily_limit, source: "policy_config", derivation: { kind: "sql", table: "policy_limits", query: "SELECT daily_limit FROM policy_limits WHERE id = 1", params: [] } },
    { fact: "approved_categories", value: facts.approved_categories, source: "policy_config", derivation: { kind: "sql", table: "categories", query: "SELECT category_id FROM categories WHERE approved = 1", params: [] } },
    { fact: "agent_cleared_categories", value: facts.agent_cleared_categories, source: "policy_config", derivation: { kind: "sql", table: "agent_category_clearances", query: "SELECT category_id FROM agent_category_clearances WHERE agent_id = ?", params: ["agent_47"] } },
    { fact: "attestation_present", value: facts.attestation_present, source: "attestation", derivation: { kind: "attestation", notaryKeyId: "notary_demo_ed25519_1", statementDigest: "a".repeat(64), verified: true } },
  ];
}

const AT = "2026-07-15T12:00:00Z";

function heroBundle(facts: Facts = HERO_FACTS): DecisionBundle {
  return buildBundle({
    requestId: facts.request_id,
    facts,
    provenance: heroProvenance(facts),
    decision: kernel.evaluate(facts),
    kernel: { kind: "reference", policyDigest: "b".repeat(64) },
    evaluatedAt: AT,
  });
}

// ---------------------------------------------------------------------------
// The happy path: an honest bundle verifies.
// ---------------------------------------------------------------------------

test("REGRESSION: a SIGNED bundle still verifies (the signature is not in the digest)", () => {
  // Turning on signing broke every bundle at once: `gateSignature` is computed
  // OVER `bundleDigest` and attached afterwards, so a verifier that recomputes
  // the digest with the signature included gets a mismatch and reports a
  // perfectly good bundle as TAMPERED. The signature cannot be inside the thing
  // it signs. Caught by running the demo; pinned here so it can't come back.
  const bundle = heroBundle();
  const signed = {
    ...bundle,
    gateSignature: { gateKeyId: "gate_demo_ed25519_1", signature: "c2lnbmF0dXJl" },
  };
  const v = verifyBundle(signed, kernel);
  assert.deepEqual(v.defects, [], "a signed bundle must not read as tampered");
  assert.equal(v.valid, true);
  // ...and the digest is identical with or without it.
  assert.equal(signed.bundleDigest, bundle.bundleDigest);
});

test("an honest bundle verifies — the auditor re-derives ALLOW themselves", () => {
  const bundle = heroBundle();
  const v = verifyBundle(bundle, kernel);
  assert.deepEqual(v.defects, []);
  assert.equal(v.valid, true);
  assert.equal(v.rederivedDecision?.decision, "allow");
});

test("bundle construction is pure — same inputs, byte-identical bundle", () => {
  // If building read the clock, content-addressing would be untestable.
  assert.deepEqual(heroBundle(), heroBundle());
  assert.equal(heroBundle().bundleDigest, heroBundle().bundleDigest);
});

test("different facts produce a different facts digest", () => {
  const other = heroBundle({ ...HERO_FACTS, amount: 341 });
  assert.notEqual(other.factsDigest, heroBundle().factsDigest);
});

test("factsDigest is key-order independent (canonical encoding)", () => {
  // The same facts assembled in a different key order must digest identically,
  // or an honest bundle round-tripped through another system looks tampered.
  const reordered = {
    attestation_present: HERO_FACTS.attestation_present,
    daily_limit: HERO_FACTS.daily_limit,
    amount: HERO_FACTS.amount,
    request_id: HERO_FACTS.request_id,
    vendor: HERO_FACTS.vendor,
    category: HERO_FACTS.category,
    requesting_agent: HERO_FACTS.requesting_agent,
    vendor_verified: HERO_FACTS.vendor_verified,
    daily_total_so_far: HERO_FACTS.daily_total_so_far,
    per_txn_cap: HERO_FACTS.per_txn_cap,
    approved_categories: HERO_FACTS.approved_categories,
    agent_cleared_categories: HERO_FACTS.agent_cleared_categories,
  } as Facts;
  assert.equal(digestFacts(reordered), digestFacts(HERO_FACTS));
});

// ---------------------------------------------------------------------------
// Tampering: the verifier's actual job.
// ---------------------------------------------------------------------------

test("editing a fact after sealing is caught", () => {
  const bundle = heroBundle();
  // Someone rewrites history: "the agent had only spent 100 today, honest."
  const doctored = {
    ...bundle,
    facts: { ...bundle.facts, daily_total_so_far: 100 },
  };
  const v = verifyBundle(doctored, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "facts_digest_mismatch"));
});

test("THE KEY TEST: a decision that does not follow from the facts is caught", () => {
  // A compromised or buggy gate records ALLOW for facts that plainly deny.
  // An audit log would happily contain this sentence and nobody could tell.
  // The verifier re-runs the arithmetic and catches it.
  const denyFacts: Facts = { ...HERO_FACTS, vendor_verified: false, attestation_present: false };
  const lying = buildBundle({
    requestId: denyFacts.request_id,
    facts: denyFacts,
    provenance: heroProvenance(denyFacts).map((p) =>
      p.fact === "vendor_verified"
        ? { ...p, value: false }
        : p.fact === "attestation_present"
          ? { ...p, value: false, derivation: { kind: "attestation" as const, notaryKeyId: "notary_demo_ed25519_1", statementDigest: "a".repeat(64), verified: false } }
          : p,
    ),
    // The lie: claim ALLOW for facts that deny.
    decision: { decision: "allow", reasons: ["all_conditions_met"], firedRules: ["allow/all_conditions_met"] },
    kernel: { kind: "reference" },
    evaluatedAt: AT,
  });

  const v = verifyBundle(lying, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "decision_mismatch"));
  // And the verifier reports what the answer SHOULD have been.
  assert.equal(v.rederivedDecision?.decision, "deny");
  assert.ok(v.rederivedDecision?.firedRules.includes("deny/vendor_not_verified"));
});

test("swapping the decision but resealing is still caught", () => {
  // A forger who understands digests reseals after editing, so the digest checks
  // pass. Re-derivation catches it anyway — you cannot reseal your way out of
  // arithmetic. This is why soundness is checked independently of integrity.
  const resealed = buildBundle({
    requestId: HERO_FACTS.request_id,
    facts: { ...HERO_FACTS, amount: 900 }, // over the 500 cap -> must deny
    provenance: heroProvenance({ ...HERO_FACTS, amount: 900 }),
    decision: { decision: "allow", reasons: ["all_conditions_met"], firedRules: ["allow/all_conditions_met"] },
    kernel: { kind: "reference" },
    evaluatedAt: AT,
  });
  const v = verifyBundle(resealed, kernel);
  assert.equal(v.valid, false);
  // Digests are internally consistent...
  assert.ok(!v.defects.some((d) => d.code === "facts_digest_mismatch"));
  assert.ok(!v.defects.some((d) => d.code === "bundle_digest_mismatch"));
  // ...and it fails anyway, on the arithmetic.
  assert.ok(v.defects.some((d) => d.code === "decision_mismatch"));
});

test("editing bundle metadata (e.g. the timestamp) is caught", () => {
  const bundle = heroBundle();
  const doctored = { ...bundle, evaluatedAt: "2020-01-01T00:00:00Z" };
  const v = verifyBundle(doctored, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "bundle_digest_mismatch"));
});

// ---------------------------------------------------------------------------
// Completeness + honesty of the provenance itself.
// ---------------------------------------------------------------------------

test("a fact with NO provenance is caught — an unexplained fact is unaudited", () => {
  // This is the hole shaped exactly like an injected fact: a value that entered
  // the decision with nobody naming its source.
  const bundle = heroBundle();
  const missing = {
    ...bundle,
    provenance: bundle.provenance.filter((p) => p.fact !== "vendor_verified"),
  };
  const v = verifyBundle(missing, kernel);
  assert.equal(v.valid, false);
  assert.ok(
    v.defects.some(
      (d) => d.code === "provenance_incomplete" && d.detail.includes("vendor_verified"),
    ),
  );
});

test("completeness is checked against EVERY field of Facts", () => {
  const bundle = heroBundle();
  const v = verifyBundle({ ...bundle, provenance: [] }, kernel);
  assert.equal(v.valid, false);
  const incomplete = v.defects.filter((d) => d.code === "provenance_incomplete");
  // All 12 Facts fields must be reported missing — the checklist is mechanical,
  // derived from the contract's own FACT_SOURCES, not from reviewer diligence.
  assert.equal(incomplete.length, Object.keys(HERO_FACTS).length);
});

test("provenance that disagrees with the fact it explains is caught", () => {
  // Worse than no provenance: a plausible, checkable-looking lie.
  const bundle = heroBundle();
  const lying = {
    ...bundle,
    provenance: bundle.provenance.map((p) =>
      p.fact === "daily_total_so_far" ? { ...p, value: 0 } : p,
    ),
  };
  const v = verifyBundle(lying, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "provenance_value_mismatch"));
});

test("provenance claiming the wrong source category is caught", () => {
  // Claiming vendor_verified came from tool_args would be the whole attack:
  // it would mean the model asserted it. The contract says vendor_registry.
  const bundle = heroBundle();
  const lying = {
    ...bundle,
    provenance: bundle.provenance.map((p) =>
      p.fact === "vendor_verified" ? { ...p, source: "tool_args" as const } : p,
    ),
  };
  const v = verifyBundle(lying, kernel);
  assert.equal(v.valid, false);
  assert.ok(
    v.defects.some(
      (d) => d.code === "provenance_value_mismatch" && d.detail.includes("vendor_registry"),
    ),
  );
});

test("duplicate provenance for one fact is caught", () => {
  const bundle = heroBundle();
  const dupe = {
    ...bundle,
    provenance: [...bundle.provenance, bundle.provenance[0]!],
  };
  const v = verifyBundle(dupe, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "provenance_duplicate"));
});

test("provenance naming a field that isn't in Facts is caught", () => {
  const bundle = heroBundle();
  const bogus = {
    ...bundle,
    provenance: [
      ...bundle.provenance,
      { fact: "secret_backdoor" as never, value: true, source: "tool_args" as const, derivation: { kind: "constant" as const, note: "?" } },
    ],
  };
  const v = verifyBundle(bogus, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.detail.includes("secret_backdoor")));
});

test("every defect is reported, not just the first", () => {
  // An auditor wants the full picture; "there is at least one problem" is a
  // worse report than "here are all of them."
  const bundle = heroBundle();
  const wrecked = {
    ...bundle,
    facts: { ...bundle.facts, daily_total_so_far: 99_999 }, // digest + decision + provenance
    provenance: bundle.provenance.filter((p) => p.fact !== "vendor_verified"), // completeness
  };
  const v = verifyBundle(wrecked, kernel);
  assert.equal(v.valid, false);
  const codes = new Set(v.defects.map((d) => d.code));
  assert.ok(codes.has("facts_digest_mismatch"));
  assert.ok(codes.has("decision_mismatch"));
  assert.ok(codes.has("provenance_incomplete"));
  assert.ok(v.defects.length >= 3);
});

// ---------------------------------------------------------------------------
// Totality + robustness.
// ---------------------------------------------------------------------------

test("verifyBundle is TOTAL — hostile input is a verdict, never a throw", () => {
  const hostile: unknown[] = [
    undefined, null, "", "nope", 42, [], {},
    { bundleVersion: 1 },
    { ...heroBundle(), facts: null },
    { ...heroBundle(), provenance: "not an array" },
    { ...heroBundle(), decision: null },
    Object.create(null),
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => verifyBundle(input, kernel));
    assert.equal(verifyBundle(input, kernel).valid, false);
  }
});

test("a kernel that throws is reported, not propagated", () => {
  const brokenKernel: PolicyKernel = {
    evaluate() {
      throw new Error("kernel exploded");
    },
  };
  const v = verifyBundle(heroBundle(), brokenKernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "decision_mismatch" && d.detail.includes("exploded")));
});

test("an unsupported bundle version is rejected", () => {
  const v = verifyBundle({ ...heroBundle(), bundleVersion: 99 }, kernel);
  assert.equal(v.valid, false);
  assert.ok(v.defects.some((d) => d.code === "version_mismatch"));
});

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

test("renderBundle traces decision -> facts -> sources for every fact", () => {
  const bundle = heroBundle();
  const out = renderBundle(bundle, verifyBundle(bundle, kernel));

  assert.ok(out.includes("DECISION  ALLOW"));
  assert.ok(out.includes("allow/all_conditions_met"));
  // Every fact appears with its source.
  for (const key of Object.keys(HERO_FACTS)) assert.ok(out.includes(key), `missing ${key}`);
  // The specific, checkable derivations.
  assert.ok(out.includes("SELECT verified FROM vendors WHERE vendor_id = ?"));
  assert.ok(out.includes("acme_corp"));
  assert.ok(out.includes("notary attestation"));
  assert.ok(out.includes("VERIFIED"));
});

test("renderBundle flags a fact with no provenance loudly", () => {
  const bundle = heroBundle();
  const missing = { ...bundle, provenance: bundle.provenance.filter((p) => p.fact !== "amount") };
  const out = renderBundle(missing, verifyBundle(missing, kernel));
  assert.ok(out.includes("NO PROVENANCE"));
  assert.ok(out.includes("FAILED VERIFICATION"));
});

test("summarizeBundle is a stable one-liner", () => {
  const s = summarizeBundle(heroBundle());
  assert.ok(s.includes("inv_2026_07_0043"));
  assert.ok(s.includes("ALLOW"));
  assert.equal(s, summarizeBundle(heroBundle()));
});

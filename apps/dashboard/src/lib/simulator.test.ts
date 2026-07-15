/**
 * @ramp/dashboard — simulator.test.ts
 *
 * Pure-logic tests for the read-only Policy Simulator helpers. No bridge, no DOM,
 * no side effects. Run `node --test`.
 *
 * Covered:
 *   - validateSimForm: required fields, non-negative whole-unit amounts.
 *   - policyChecks: each check reflects the authoritative facts (pass/fail).
 *   - truncateDigest: keeps the algo + a recognizable prefix.
 *   - SCENARIOS / scenarioToForm: seeded ids validate and round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "./types.js";
import {
  EMPTY_SIM_FORM,
  SCENARIOS,
  policyChecks,
  scenarioToForm,
  truncateDigest,
  validateSimForm,
  type SimFormValues,
} from "./simulator.js";

const baseForm: SimFormValues = {
  agent: "agent_47",
  vendor: "acme_corp",
  amount: "340",
  category: "office_supplies",
  currency: "USD",
};

// The seeded happy-path facts (agent_47 / acme_corp / office_supplies, 340).
const allowFacts: Facts = {
  request_id: "req_sim",
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
};

test("validateSimForm accepts a well-formed form", () => {
  const r = validateSimForm(baseForm);
  assert.equal(r.valid, true);
  assert.equal(r.amount, 340);
  assert.deepEqual(r.errors, {});
});

test("validateSimForm flags missing required fields", () => {
  const r = validateSimForm({ ...EMPTY_SIM_FORM, amount: "" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.agent);
  assert.ok(r.errors.vendor);
  assert.ok(r.errors.category);
  assert.ok(r.errors.amount);
});

test("validateSimForm rejects negative and fractional amounts", () => {
  assert.ok(validateSimForm({ ...baseForm, amount: "-5" }).errors.amount);
  assert.ok(validateSimForm({ ...baseForm, amount: "12.5" }).errors.amount);
  assert.ok(validateSimForm({ ...baseForm, amount: "abc" }).errors.amount);
  assert.equal(validateSimForm({ ...baseForm, amount: "0" }).valid, true);
});

test("policyChecks all pass for the seeded allow facts", () => {
  const checks = policyChecks(allowFacts, "USD");
  assert.equal(checks.length, 5);
  assert.ok(checks.every((c) => c.pass));
  const keys = checks.map((c) => c.key);
  assert.deepEqual(keys, [
    "per_txn_cap",
    "daily_limit",
    "vendor_verified",
    "category_approved",
    "agent_cleared",
  ]);
});

test("policyChecks fails the right check per deny reason", () => {
  const overCap = policyChecks({ ...allowFacts, amount: 600 }, "USD");
  assert.equal(overCap.find((c) => c.key === "per_txn_cap")?.pass, false);

  const overDaily = policyChecks({ ...allowFacts, amount: 400 }, "USD");
  assert.equal(overDaily.find((c) => c.key === "daily_limit")?.pass, false);
  // still under the per-txn cap
  assert.equal(overDaily.find((c) => c.key === "per_txn_cap")?.pass, true);

  const unverified = policyChecks({ ...allowFacts, vendor_verified: false }, "USD");
  assert.equal(unverified.find((c) => c.key === "vendor_verified")?.pass, false);

  const badCat = policyChecks({ ...allowFacts, category: "crypto" }, "USD");
  assert.equal(badCat.find((c) => c.key === "category_approved")?.pass, false);

  const uncleared = policyChecks({ ...allowFacts, category: "travel" }, "USD");
  assert.equal(uncleared.find((c) => c.key === "category_approved")?.pass, true);
  assert.equal(uncleared.find((c) => c.key === "agent_cleared")?.pass, false);
});

test("truncateDigest keeps algo + prefix and shrinks long hashes", () => {
  assert.equal(truncateDigest("sha256:abcdef0123456789"), "sha256:abcdef…");
  // short hashes are returned unchanged
  assert.equal(truncateDigest("sha256:abcd"), "sha256:abcd");
  // no colon → unchanged
  assert.equal(truncateDigest("plainstring"), "plainstring");
});

test("every seeded scenario round-trips to a valid form", () => {
  assert.ok(SCENARIOS.length >= 5);
  assert.ok(SCENARIOS.some((s) => s.expect === "allow"));
  assert.ok(SCENARIOS.filter((s) => s.expect === "deny").length >= 4);
  for (const s of SCENARIOS) {
    const form = scenarioToForm(s);
    const r = validateSimForm(form);
    assert.equal(r.valid, true, `scenario ${s.id} should produce a valid form`);
    assert.equal(r.amount, s.input.amount);
  }
});

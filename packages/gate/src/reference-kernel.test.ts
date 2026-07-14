/**
 * @ramp/gate — golden tests for the reference kernel.
 *
 * Uses the built-in `node:test` runner (zero extra deps). These are the golden
 * cases: they pin the allow/deny semantics that MUST match `datalog/policy.dl`
 * and stay byte-stable across the reference and (future) wasm kernels.
 *
 * Determinism is asserted explicitly: the same `Facts` evaluated twice must yield
 * a deep-equal `Decision`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "@ramp/shared";
import { ReferenceKernel, referenceKernel } from "./reference-kernel.js";

/**
 * Base facts = the hero happy path (req_9f, agent_47, acme_corp, office_supplies,
 * 340) against the seeded org (per_txn_cap 500, daily_limit 1500, prior 1140).
 * 1140 + 340 = 1480 <= 1500 => ALLOW. Individual tests override single fields.
 */
function baseFacts(overrides: Partial<Facts> = {}): Facts {
  const base: Facts = {
    request_id: "req_9f",
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
  return { ...base, ...overrides };
}

test("happy path: $340 office_supplies -> allow", () => {
  const d = referenceKernel.evaluate(baseFacts());
  assert.equal(d.decision, "allow");
  assert.deepEqual(d.firedRules, ["allow/all_conditions_met"]);
  assert.equal(d.reasons.length, 1);
});

test("determinism: same facts -> same decision twice (allow)", () => {
  const facts = baseFacts();
  const a = referenceKernel.evaluate(facts);
  const b = referenceKernel.evaluate(facts);
  assert.deepEqual(a, b);
});

test("determinism: same facts -> same decision twice (deny)", () => {
  const facts = baseFacts({ vendor: "sketchy_llc", vendor_verified: false });
  const a = referenceKernel.evaluate(facts);
  const b = referenceKernel.evaluate(facts);
  assert.deepEqual(a, b);
});

test("deny: amount over per_txn_cap", () => {
  const d = referenceKernel.evaluate(baseFacts({ amount: 501 }));
  assert.equal(d.decision, "deny");
  assert.ok(d.firedRules.includes("deny/over_per_txn_cap"));
});

test("deny: unverified vendor", () => {
  const d = referenceKernel.evaluate(
    baseFacts({ vendor: "sketchy_llc", vendor_verified: false }),
  );
  assert.equal(d.decision, "deny");
  assert.ok(d.firedRules.includes("deny/vendor_not_verified"));
});

test("deny: daily_limit exceeded (amount 361 tips over 1500)", () => {
  const d = referenceKernel.evaluate(baseFacts({ amount: 361 }));
  assert.equal(d.decision, "deny");
  assert.ok(d.firedRules.includes("deny/daily_limit_exceeded"));
});

test("deny: category not on approved list (crypto)", () => {
  const d = referenceKernel.evaluate(baseFacts({ category: "crypto" }));
  assert.equal(d.decision, "deny");
  assert.ok(d.firedRules.includes("deny/category_not_approved"));
  // crypto is also not in the agent's cleared set -> uncleared deny fires too.
  assert.ok(d.firedRules.includes("deny/agent_uncleared_for_category"));
});

test("deny: category approved but agent uncleared (travel)", () => {
  const d = referenceKernel.evaluate(baseFacts({ category: "travel" }));
  assert.equal(d.decision, "deny");
  assert.ok(d.firedRules.includes("deny/agent_uncleared_for_category"));
  // travel IS approved, so category_not_approved must NOT fire.
  assert.ok(!d.firedRules.includes("deny/category_not_approved"));
});

test("boundary: amount exactly at per_txn_cap (500) allows if daily fits", () => {
  // Lower prior so 500 fits under the daily limit: 1000 + 500 = 1500 <= 1500.
  const d = referenceKernel.evaluate(
    baseFacts({ amount: 500, daily_total_so_far: 1000 }),
  );
  assert.equal(d.decision, "allow");
});

test("boundary: daily total exactly at daily_limit (1500) allows", () => {
  // 1160 + 340 = 1500 <= 1500 => allow (the <= boundary, not >).
  const d = referenceKernel.evaluate(baseFacts({ daily_total_so_far: 1160 }));
  assert.equal(d.decision, "allow");
});

test("deny dominates: multiple triggers all appear, decision is deny", () => {
  const d = referenceKernel.evaluate(
    baseFacts({
      vendor: "sketchy_llc",
      vendor_verified: false,
      amount: 999,
      category: "crypto",
    }),
  );
  assert.equal(d.decision, "deny");
  // Fixed evaluation order: vendor, per_txn_cap, category, agent, daily.
  assert.deepEqual(d.firedRules, [
    "deny/vendor_not_verified",
    "deny/over_per_txn_cap",
    "deny/category_not_approved",
    "deny/agent_uncleared_for_category",
    "deny/daily_limit_exceeded",
  ]);
});

test("class and singleton agree", () => {
  const facts = baseFacts();
  const viaClass = new ReferenceKernel().evaluate(facts);
  const viaSingleton = referenceKernel.evaluate(facts);
  assert.deepEqual(viaClass, viaSingleton);
});

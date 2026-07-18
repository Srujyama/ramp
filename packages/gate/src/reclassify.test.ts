/**
 * @ramp/gate — tests for the policy what-if replay.
 *
 * The invariant: overriding a policy DIAL and re-running the kernel produces the
 * verdict that dial change implies, and touches NOTHING else about the facts. A
 * what-if that silently altered the amount, the vendor, or a budget would answer a
 * different question than the one asked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "@ramp/shared";
import { referenceKernel } from "./reference-kernel.js";
import { applyPolicyOverrides, reclassify, hasOverrides } from "./reclassify.js";

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
    attestation_present: true,
    agent_identity_verified: true,
    escalation_threshold: 400,
    vendor_risk_tier: "standard",
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: 6,
    duplicate_recent_count: 0,
  };
  return { ...base, ...overrides };
}

test("hasOverrides: true only when a dial is set", () => {
  assert.equal(hasOverrides({}), false);
  assert.equal(hasOverrides({ per_txn_cap: 300 }), true);
});

test("applyPolicyOverrides touches only the named dials", () => {
  const f = baseFacts();
  const g = applyPolicyOverrides(f, { per_txn_cap: 300, daily_limit: 1000 });
  assert.equal(g.per_txn_cap, 300);
  assert.equal(g.daily_limit, 1000);
  // everything else identical
  assert.equal(g.amount, f.amount);
  assert.equal(g.vendor, f.vendor);
  assert.equal(g.escalation_threshold, f.escalation_threshold);
  assert.equal(g.velocity_limit, f.velocity_limit);
  assert.deepEqual(g.approved_categories, f.approved_categories);
  // input not mutated
  assert.equal(f.per_txn_cap, 500);
});

test("lowering the cap flips a formerly-allowed payment to deny", () => {
  // $340 allowed at cap 500. Lower the cap to 300 → over_per_txn_cap → deny.
  const f = baseFacts({ daily_total_so_far: 0 }); // isolate the cap effect
  assert.equal(referenceKernel.evaluate(f).decision, "allow");
  const r = reclassify(f, "allow", { per_txn_cap: 300 }, referenceKernel);
  assert.equal(r.before, "allow");
  assert.equal(r.after, "deny");
  assert.ok(r.changed);
  assert.ok(r.afterDecision.firedRules.includes("deny/over_per_txn_cap"));
});

test("raising the daily limit rescues a daily-limit deny", () => {
  // 1140 + 400 > 1500 denies; raise the daily limit to 2000 and it allows.
  const f = baseFacts({ amount: 400 });
  assert.equal(referenceKernel.evaluate(f).decision, "deny");
  const r = reclassify(f, "deny", { daily_limit: 2000 }, referenceKernel);
  assert.equal(r.after, "allow");
  assert.ok(r.changed);
});

test("lowering the escalation threshold turns an allow into a hold", () => {
  // $340 allowed; drop the threshold to 300 → over_escalation_threshold → escalate.
  const f = baseFacts({ daily_total_so_far: 0 });
  assert.equal(referenceKernel.evaluate(f).decision, "allow");
  const r = reclassify(f, "allow", { escalation_threshold: 300 }, referenceKernel);
  assert.equal(r.after, "escalate");
  assert.ok(r.changed);
});

test("a categorical deny is immune to policy-dial changes", () => {
  // Unverified vendor denies no matter the caps — the dials don't touch D1.
  const f = baseFacts({ vendor_verified: false });
  const r = reclassify(f, "deny", { per_txn_cap: 100000, daily_limit: 100000 }, referenceKernel);
  assert.equal(r.after, "deny");
  assert.equal(r.changed, false);
});

test("no overrides is a no-op replay (verdict unchanged)", () => {
  const f = baseFacts({ amount: 400 }); // a deny
  const r = reclassify(f, "deny", {}, referenceKernel);
  assert.equal(r.before, "deny");
  assert.equal(r.after, "deny");
  assert.equal(r.changed, false);
});

test("a malformed override is rejected, not silently ignored", () => {
  assert.throws(() => applyPolicyOverrides(baseFacts(), { per_txn_cap: -5 }));
  assert.throws(() => applyPolicyOverrides(baseFacts(), { daily_limit: 3.5 }));
});

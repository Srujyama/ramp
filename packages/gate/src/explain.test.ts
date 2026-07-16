/**
 * @ramp/gate — tests for the counterfactual explainer.
 *
 * The property that matters: the explainer is never MORE PERMISSIVE than the
 * kernel. Every "would have allowed at ≤ X" it prints is re-confirmed by running
 * the real kernel at X (allows) and X+1 (does not) — so the explanation cannot
 * describe a flip the gate would not actually make.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "@ramp/shared";
import { referenceKernel } from "./reference-kernel.js";
import { explainDecision } from "./explain.js";

/** Hero base facts (same shape as the kernel golden tests). */
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
    escalation_threshold: 400,
    vendor_risk_tier: "standard",
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: 6,
    duplicate_recent_count: 0,
  };
  return { ...base, ...overrides };
}

/** Explain the kernel's own verdict for `facts`. */
function explain(facts: Facts) {
  return explainDecision(facts, referenceKernel.evaluate(facts), referenceKernel);
}

test("allow: the counterfactual is trivial, headline says settled", () => {
  const e = explain(baseFacts());
  assert.equal(e.outcome, "allow");
  assert.equal(e.firedRules.length, 0);
  assert.equal(e.counterfactual.maxAllowAmount, 340);
  assert.match(e.headline, /Allowed/);
});

test("over per-txn cap: maxAllowAmount is the cap, and the kernel confirms the boundary", () => {
  // 900 > cap 500. Also 1140 + 900 > 1500 (daily). The binding allow amount is the
  // TIGHTER of the two amount limits: min(cap 500, daily headroom 360) = 360.
  const facts = baseFacts({ amount: 900 });
  const e = explain(facts);
  assert.equal(e.outcome, "deny");
  const max = e.counterfactual.maxAllowAmount;
  assert.equal(max, 360);
  // Re-confirm against the real kernel: allows at max, denies at max+1.
  assert.equal(referenceKernel.evaluate({ ...facts, amount: max! }).decision, "allow");
  assert.notEqual(referenceKernel.evaluate({ ...facts, amount: max! + 1 }).decision, "allow");
  assert.match(e.headline, /≤ 360/);
});

test("daily limit: headroom-bound counterfactual", () => {
  // Within the cap (400 <= 500) but over the day: 1140 + 400 > 1500. Headroom 360.
  const facts = baseFacts({ amount: 400 });
  const e = explain(facts);
  assert.equal(e.outcome, "deny");
  assert.ok(e.firedRules.some((r) => r.id === "deny/daily_limit_exceeded"));
  assert.equal(e.counterfactual.maxAllowAmount, 360);
});

test("categorical block (unverified vendor): no amount clears it", () => {
  const facts = baseFacts({ vendor_verified: false, amount: 340 });
  const e = explain(facts);
  assert.equal(e.outcome, "deny");
  assert.equal(e.counterfactual.maxAllowAmount, null);
  assert.ok(e.counterfactual.categoricalBlockers.includes("deny/vendor_not_verified"));
  const rule = e.firedRules.find((r) => r.id === "deny/vendor_not_verified");
  assert.ok(rule?.categorical);
  assert.match(rule!.fix, /verify vendor/);
  assert.match(e.headline, /no amount clears it/);
});

test("missing attestation is categorical too — amount can't buy it off", () => {
  const facts = baseFacts({ attestation_present: false });
  const e = explain(facts);
  assert.equal(e.counterfactual.maxAllowAmount, null);
  assert.ok(e.counterfactual.categoricalBlockers.includes("deny/attestation_invalid"));
});

test("escalation: over threshold but within caps — flips to allow below the threshold", () => {
  // agent with daily headroom so the ONLY thing firing is E1. Use a fresh agent
  // state: no prior spend, amount 450 (> threshold 400, < cap 500).
  const facts = baseFacts({ amount: 450, daily_total_so_far: 0 });
  const e = explain(facts);
  assert.equal(e.outcome, "escalate");
  assert.ok(e.firedRules.some((r) => r.id === "escalate/over_escalation_threshold"));
  // Would settle unattended at <= escalation_threshold (400).
  assert.equal(e.counterfactual.maxAllowAmount, 400);
  assert.equal(referenceKernel.evaluate({ ...facts, amount: 400 }).decision, "allow");
  assert.equal(referenceKernel.evaluate({ ...facts, amount: 401 }).decision, "escalate");
  assert.match(e.headline, /Held for a human/);
});

test("categorical escalation (velocity): no smaller amount settles it unattended", () => {
  const facts = baseFacts({ amount: 100, daily_total_so_far: 0, recent_txn_count: 6, velocity_limit: 6 });
  const e = explain(facts);
  assert.equal(e.outcome, "escalate");
  assert.equal(e.counterfactual.maxAllowAmount, null);
  assert.ok(e.counterfactual.categoricalBlockers.includes("escalate/velocity_exceeded"));
  assert.match(e.headline, /no smaller amount/);
});

test("budget_exceeded: the fix names the specific budget line", () => {
  const facts = baseFacts({
    amount: 300,
    daily_total_so_far: 0,
    budgets: [{ scope: "category_daily", key: "office_supplies", limit: 500, spent: 400 }],
  });
  const e = explain(facts);
  assert.equal(e.outcome, "deny");
  const rule = e.firedRules.find((r) => r.id === "deny/budget_exceeded");
  assert.ok(rule);
  // room = 500 - 400 = 100
  assert.equal(rule!.clearsAtAmountAtMost, 100);
  assert.match(rule!.fix, /category_daily budget for "office_supplies"/);
  assert.equal(e.counterfactual.maxAllowAmount, 100);
});

test("deny that becomes an escalation below a threshold reports maxNonDenyAmount", () => {
  // Over cap denies; drop below cap and it's within caps but over escalation
  // threshold => escalate (not deny). So maxAllowAmount < maxNonDenyAmount.
  const facts = baseFacts({ amount: 900, daily_total_so_far: 0 });
  const e = explain(facts);
  assert.equal(e.outcome, "deny");
  // allow only at <= threshold 400; not-deny (escalate ok) at <= cap 500.
  assert.equal(e.counterfactual.maxAllowAmount, 400);
  assert.equal(e.counterfactual.maxNonDenyAmount, 500);
  assert.equal(referenceKernel.evaluate({ ...facts, amount: 500 }).decision, "escalate");
  assert.equal(referenceKernel.evaluate({ ...facts, amount: 501 }).decision, "deny");
});

test("multiple broken budgets each map to their own line, in fired order", () => {
  const facts = baseFacts({
    amount: 300,
    daily_total_so_far: 0,
    budgets: [
      { scope: "category_daily", key: "office_supplies", limit: 500, spent: 400 },
      { scope: "vendor_daily", key: "acme_corp", limit: 350, spent: 200 },
    ],
  });
  const e = explain(facts);
  const budgetRules = e.firedRules.filter((r) => r.id === "deny/budget_exceeded");
  assert.equal(budgetRules.length, 2);
  assert.match(budgetRules[0]!.fix, /office_supplies/);
  assert.equal(budgetRules[0]!.clearsAtAmountAtMost, 100); // 500-400
  assert.match(budgetRules[1]!.fix, /acme_corp/);
  assert.equal(budgetRules[1]!.clearsAtAmountAtMost, 150); // 350-200
});

test("nearestStop: an allow reports how close it was to being stopped", () => {
  // Hero: amount 340, daily_total 1140, limit 1500 → daily headroom 360 → denied at 361.
  // Escalation threshold 400 → held at 401. Nearest worse is the deny at 361.
  const e = explain(baseFacts());
  assert.equal(e.outcome, "allow");
  assert.ok(e.nearestStop);
  assert.equal(e.nearestStop!.amount, 361);
  assert.equal(e.nearestStop!.outcome, "deny");
  assert.equal(e.nearestStop!.margin, 21); // 361 - 340
  assert.equal(e.nearestStop!.rule, "deny/daily_limit_exceeded");
  // Kernel-confirm the boundary: allow at 360, deny at 361.
  assert.equal(referenceKernel.evaluate({ ...baseFacts(), amount: 360 }).decision, "allow");
  assert.equal(referenceKernel.evaluate({ ...baseFacts(), amount: 361 }).decision, "deny");
  assert.match(e.headline, /21 short of being denied/);
});

test("nearestStop: when the escalation threshold is the nearest edge, it's a hold", () => {
  // Fresh agent (no prior), amount 340, threshold 400 → held at 401, denied at cap+1 (501).
  // Nearest worse is the hold at 401.
  const e = explain(baseFacts({ daily_total_so_far: 0 }));
  assert.equal(e.outcome, "allow");
  assert.equal(e.nearestStop!.amount, 401);
  assert.equal(e.nearestStop!.outcome, "escalate");
  assert.equal(e.nearestStop!.rule, "escalate/over_escalation_threshold");
});

test("nearestStop: an escalate reports how close it is to an outright deny", () => {
  // amount 450, no prior, threshold 400 → escalate. Cap 500 → denied at 501.
  const e = explain(baseFacts({ amount: 450, daily_total_so_far: 0 }));
  assert.equal(e.outcome, "escalate");
  assert.ok(e.nearestStop);
  assert.equal(e.nearestStop!.outcome, "deny");
  assert.equal(e.nearestStop!.amount, 501);
  assert.equal(e.nearestStop!.margin, 51);
});

test("nearestStop: a deny has none (nothing worse to reach)", () => {
  const e = explain(baseFacts({ amount: 900 }));
  assert.equal(e.outcome, "deny");
  assert.equal(e.nearestStop, null);
});

test("determinism: explaining the same decision twice is deep-equal", () => {
  const facts = baseFacts({ amount: 900 });
  const a = explain(facts);
  const b = explain(facts);
  assert.deepEqual(a, b);
});

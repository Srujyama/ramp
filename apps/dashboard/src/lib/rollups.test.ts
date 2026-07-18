import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeVendors, summarizeCategories, dailySpend } from "./rollups.js";
import { mkView, mkFacts } from "./testfixtures.js";

test("summarizeVendors carries real verified/riskTier from the most recent facts, and a real label", () => {
  const rows = [
    mkView({
      decisionId: "d1",
      vendorId: "newco_ltd",
      ts: "2026-07-15 09:00:00",
      facts: mkFacts({ vendor: "newco_ltd", vendor_verified: true, vendor_risk_tier: "elevated" }),
    }),
  ];
  const [v] = summarizeVendors(rows);
  assert.ok(v);
  assert.equal(v.label, "NewCo Ltd");
  assert.equal(v.domain, "newco.example.com");
  assert.equal(v.verified, true);
  assert.equal(v.riskTier, "elevated");
});

test("summarizeVendors: unknown vendor without facts has null verified/riskTier, never guessed", () => {
  const rows = [mkView({ decisionId: "d1", vendorId: "sketchy_llc", facts: null })];
  const [v] = summarizeVendors(rows);
  assert.ok(v);
  assert.equal(v.verified, null);
  assert.equal(v.riskTier, null);
  assert.equal(v.label, "Sketchy LLC"); // still a real seed label even with no facts
});

test("summarizeVendors: settledSpend excludes denies and failed executions", () => {
  const rows = [
    mkView({ decisionId: "d1", vendorId: "acme_corp", outcome: "allow", amount: 100, execution: { settlementId: "r1", executionId: "e1", status: "settled", provider: "sandbox", executedAt: "2026-07-15 10:00:00" } }),
    mkView({ decisionId: "d2", vendorId: "acme_corp", outcome: "deny", status: "denied", amount: 5000, execution: null }),
  ];
  const [v] = summarizeVendors(rows);
  assert.ok(v);
  assert.equal(v.settledSpend, 100);
  assert.equal(v.outcomeCounts.deny, 1);
});

test("summarizeCategories reports approved from the most recent facts naming that category", () => {
  const rows = [
    mkView({ decisionId: "d1", category: "crypto", outcome: "deny", status: "denied", facts: mkFacts({ category: "crypto", approved_categories: ["office_supplies"] }) }),
  ];
  const [c] = summarizeCategories(rows);
  assert.ok(c);
  assert.equal(c.approved, false);
});

test("summarizeVendors/summarizeCategories: allowed-but-unexecuted money is not spend", () => {
  // Same rule as agents.ts, via the one shared predicate: authorisation is not
  // settlement, so an allow with no execution row contributes nothing.
  const rows = [
    mkView({ decisionId: "d1", vendorId: "acme_corp", category: "software", outcome: "allow", amount: 100, execution: { settlementId: "r1", executionId: "e1", status: "settled", provider: "sandbox", executedAt: "2026-07-15 10:00:00" } }),
    mkView({ decisionId: "d2", vendorId: "acme_corp", category: "software", outcome: "allow", amount: 9000, execution: null }),
    mkView({ decisionId: "d3", vendorId: "acme_corp", category: "software", outcome: "allow", amount: 700, execution: { settlementId: "r3", executionId: "e3", status: "failed", provider: "sandbox", executedAt: "2026-07-15 10:00:00" } }),
  ];
  const [v] = summarizeVendors(rows);
  assert.ok(v);
  assert.equal(v.settledSpend, 100);

  const [c] = summarizeCategories(rows);
  assert.ok(c);
  assert.equal(c.settledSpend, 100);
});

test("dailySpend: an allowed-but-unexecuted decision counts as allowed but adds 0 spend", () => {
  const rows = [
    mkView({ decisionId: "d1", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 340, execution: null }),
  ];
  const [day] = dailySpend(rows);
  assert.ok(day);
  assert.equal(day.allowed, 1); // it IS an allow decision
  assert.equal(day.settledSpend, 0); // but no money moved
});

test("dailySpend buckets by UTC calendar day, oldest first, and never invents a settled amount for a deny", () => {
  const rows = [
    mkView({ decisionId: "d1", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 100, execution: { settlementId: "r1", executionId: "e1", status: "settled", provider: "sandbox", executedAt: "2026-07-15 09:00:00" } }),
    mkView({ decisionId: "d2", ts: "2026-07-15 15:00:00", outcome: "deny", status: "denied", amount: 9999, execution: null }),
    mkView({ decisionId: "d3", ts: "2026-07-14 09:00:00", outcome: "escalate", status: "escalated", amount: 450, execution: null }),
  ];
  const points = dailySpend(rows);
  assert.deepEqual(points.map((p) => p.date), ["2026-07-14", "2026-07-15"]);
  const day15 = points[1];
  assert.ok(day15);
  assert.equal(day15.settledSpend, 100); // the $9999 deny must not appear here
  assert.equal(day15.allowed, 1);
  assert.equal(day15.denied, 1);
  const day14 = points[0];
  assert.ok(day14);
  assert.equal(day14.escalated, 1);
});

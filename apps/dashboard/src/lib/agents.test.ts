import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgents } from "./agents.js";
import { mkView, mkFacts } from "./testfixtures.js";

test("groups decisions by agent and tallies outcomes honestly", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", outcome: "allow", ts: "2026-07-15 10:00:00" }),
    mkView({ decisionId: "d2", agentId: "agent_47", outcome: "deny", status: "denied", ts: "2026-07-15 10:01:00" }),
    mkView({ decisionId: "d3", agentId: "agent_12", outcome: "escalate", status: "escalated", ts: "2026-07-15 10:02:00" }),
  ];
  const summaries = summarizeAgents(rows);
  assert.equal(summaries.length, 2);

  const a47 = summaries.find((s) => s.agentId === "agent_47");
  assert.ok(a47);
  assert.equal(a47.decisionCount, 2);
  assert.equal(a47.outcomeCounts.allow, 1);
  assert.equal(a47.outcomeCounts.deny, 1);
  assert.equal(a47.label, "Procurement Agent 47"); // real seed label, not a raw id
});

test("settledSpend counts only allow decisions with a settled receipt", () => {
  const rows = [
    mkView({
      decisionId: "d1",
      agentId: "agent_47",
      outcome: "allow",
      amount: 340,
      execution: { receiptId: "r1", executionId: "e1", status: "settled", provider: "sandbox", executedAt: "2026-07-15 10:00:00" },
    }),
    mkView({
      decisionId: "d2",
      agentId: "agent_47",
      outcome: "allow",
      amount: 900,
      execution: { receiptId: "r2", executionId: "e2", status: "failed", provider: "sandbox", executedAt: "2026-07-15 10:01:00" },
    }),
    mkView({ decisionId: "d3", agentId: "agent_47", outcome: "deny", status: "denied", amount: 1000, execution: null }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  // Only the settled $340 counts — the failed $900 and the denied $1000 must not.
  assert.equal(a47.settledSpend, 340);
});

test("dailyTotalSoFar is copied verbatim from the most recent decision's facts, never summed", () => {
  const rows = [
    mkView({ decisionId: "old", agentId: "agent_47", ts: "2026-07-15 09:00:00", facts: mkFacts({ daily_total_so_far: 800 }) }),
    mkView({ decisionId: "new", agentId: "agent_47", ts: "2026-07-15 11:00:00", facts: mkFacts({ daily_total_so_far: 1140 }) }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 1140); // the newer figure, not 800+1140
});

test("clearedCategories unions across every decision's facts for that agent", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", facts: mkFacts({ agent_cleared_categories: ["office_supplies"] }) }),
    mkView({ decisionId: "d2", agentId: "agent_47", facts: mkFacts({ agent_cleared_categories: ["software", "travel"] }) }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.deepEqual(a47.clearedCategories, ["office_supplies", "software", "travel"]);
});

test("topVendor picks the vendor with the most allowed spend, ignoring denies", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", vendorId: "acme_corp", outcome: "allow", amount: 100 }),
    mkView({ decisionId: "d2", agentId: "agent_47", vendorId: "newco_ltd", outcome: "allow", amount: 250 }),
    mkView({ decisionId: "d3", agentId: "agent_47", vendorId: "newco_ltd", outcome: "deny", status: "denied", amount: 9999 }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.deepEqual(a47.topVendor, { vendorId: "newco_ltd", amount: 250 });
});

test("proofValidCount and flaggedCount tally independently-verified state", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47" }), // default fixture: reason "ok"
    mkView({
      decisionId: "d2",
      agentId: "agent_47",
      proofVerification: { proofPresent: true, proofVerified: false, expectedProofId: "x", actualProofId: "y", reason: "mismatch" },
    }),
    // corrupt: true and proof-verification are separate concerns (record-level
    // corruption vs. proof-integrity — see CLAUDE.md "two proof systems"), so a
    // record can be flagged as corrupt while its proof still recomputes "ok".
    mkView({ decisionId: "d3", agentId: "agent_47", corrupt: true }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.equal(a47.proofValidCount, 2); // d1 and d3 both carry reason "ok"
  assert.equal(a47.flaggedCount, 2); // the mismatch row + the corrupt row
});

test("fleet is sorted by daily total descending, deterministic on ties", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_12", facts: mkFacts({ daily_total_so_far: 200 }) }),
    mkView({ decisionId: "d2", agentId: "agent_47", facts: mkFacts({ daily_total_so_far: 1140 }) }),
  ];
  const summaries = summarizeAgents(rows);
  assert.deepEqual(summaries.map((s) => s.agentId), ["agent_47", "agent_12"]);
});

test("an agent with no facts on any decision has null caps/daily total, not zero", () => {
  const rows = [mkView({ decisionId: "d1", agentId: "agent_47", facts: null })];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, null);
  assert.equal(a47.perTxnCap, null);
});

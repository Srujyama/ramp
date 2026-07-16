import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgents } from "./agents.js";
import { mkView, mkFacts } from "./testfixtures.js";

// Pin "today" so the derived daily total is testable without a real clock.
const NOW = new Date("2026-07-15T12:00:00Z");
const settled = (id: string) => ({
  receiptId: `r_${id}`,
  executionId: `e_${id}`,
  status: "settled" as const,
  provider: "sandbox",
  executedAt: "2026-07-15 10:00:00",
});
const failed = (id: string) => ({ ...settled(id), status: "failed" as const });

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

// --- dailyTotalSoFar: derived from transactions, never from the snapshot ----

test("dailyTotalSoFar is DERIVED from today's settled transactions, not read from facts", () => {
  // The snapshot lies (1140). The transactions say 340 + 319 = 659 settled.
  // This is the exact shape of the reported bug: the card read the snapshot.
  const rows = [
    mkView({
      decisionId: "d1",
      agentId: "agent_47",
      ts: "2026-07-15 09:00:00",
      outcome: "allow",
      amount: 340,
      execution: settled("d1"),
      facts: mkFacts({ daily_total_so_far: 1140 }),
    }),
    mkView({
      decisionId: "d2",
      agentId: "agent_47",
      ts: "2026-07-15 11:00:00",
      outcome: "allow",
      amount: 319,
      execution: settled("d2"),
      facts: mkFacts({ daily_total_so_far: 1140 }),
    }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 659); // derived wins
  assert.notEqual(a47.dailyTotalSoFar, 1140); // the fabricated snapshot loses
});

test("the reported bug: no mix of denied/held/unexecuted rows can sum into today's total", () => {
  // Reproduces the user's fleet: only $340 (allowed, NOT executed) and $319
  // (settled) exist today. 1140 was only reachable by adding two denies and an
  // escalation — money that never moved.
  const rows = [
    mkView({ decisionId: "allowed_unexecuted", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 340, execution: null }),
    mkView({ decisionId: "settled", agentId: "agent_47", ts: "2026-07-15 09:30:00", outcome: "allow", amount: 319, execution: settled("s") }),
    mkView({ decisionId: "denied_1", agentId: "agent_47", ts: "2026-07-15 10:00:00", outcome: "deny", status: "denied", amount: 260, execution: null }),
    mkView({ decisionId: "denied_2", agentId: "agent_47", ts: "2026-07-15 10:30:00", outcome: "deny", status: "denied", amount: 111, execution: null }),
    mkView({ decisionId: "held", agentId: "agent_47", ts: "2026-07-15 11:00:00", outcome: "escalate", status: "escalated", amount: 450, execution: null }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 319); // ONLY the settled row
});

test("a denied decision contributes 0 spend", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "deny", status: "denied", amount: 5000, execution: null }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 0);
  assert.equal(a47.settledSpend, 0);
});

test("an allowed-but-not-executed decision contributes 0 spend", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 340, execution: null }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 0);
  assert.equal(a47.settledSpend, 0);
});

test("an allowed decision whose execution FAILED contributes 0 spend", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 900, execution: failed("d1") }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 0);
  assert.equal(a47.settledSpend, 0);
});

test("an escalated (held) decision contributes 0 spend", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "escalate", status: "escalated", amount: 450, execution: null }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 0);
});

test("only allowed+settled counts, and only on today's UTC calendar day", () => {
  const rows = [
    // yesterday, settled — real spend, but not TODAY's total
    mkView({ decisionId: "yday", agentId: "agent_47", ts: "2026-07-14 23:59:59", outcome: "allow", amount: 1000, execution: settled("y") }),
    // today, settled
    mkView({ decisionId: "today", agentId: "agent_47", ts: "2026-07-15 00:00:01", outcome: "allow", amount: 250, execution: settled("t") }),
  ];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 250); // today only
  assert.equal(a47.settledSpend, 1250); // window-wide settled spend keeps both
});

test("dailyTotalSoFar is 0 (honest), not null, when nothing settled today", () => {
  const rows = [mkView({ decisionId: "d1", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "deny", status: "denied", execution: null })];
  const [a47] = summarizeAgents(rows, NOW);
  assert.ok(a47);
  assert.equal(a47.dailyTotalSoFar, 0);
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

test("topVendor ranks on SETTLED spend, ignoring denies and unexecuted allows", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", vendorId: "acme_corp", outcome: "allow", amount: 100, execution: settled("d1") }),
    mkView({ decisionId: "d2", agentId: "agent_47", vendorId: "newco_ltd", outcome: "allow", amount: 250, execution: settled("d2") }),
    mkView({ decisionId: "d3", agentId: "agent_47", vendorId: "newco_ltd", outcome: "deny", status: "denied", amount: 9999 }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.deepEqual(a47.topVendor, { vendorId: "newco_ltd", amount: 250 });
});

test("topVendor cannot be crowned by allowed-but-unexecuted money", () => {
  // acme actually settled $100. newco was authorised $9000 but never executed —
  // it must not out-rank acme, or the card would contradict the settled-spend
  // vendor list rendered right next to it.
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", vendorId: "acme_corp", outcome: "allow", amount: 100, execution: settled("d1") }),
    mkView({ decisionId: "d2", agentId: "agent_47", vendorId: "newco_ltd", outcome: "allow", amount: 9000, execution: null }),
  ];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.deepEqual(a47.topVendor, { vendorId: "acme_corp", amount: 100 });
});

test("topVendor is null when nothing has settled, never a fabricated leader", () => {
  const rows = [mkView({ decisionId: "d1", agentId: "agent_47", vendorId: "newco_ltd", outcome: "allow", amount: 9000, execution: null })];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.equal(a47.topVendor, null);
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

test("fleet is sorted by DERIVED daily total descending, deterministic on ties", () => {
  // Snapshots are inverted vs. reality: agent_12's facts claim 200 and
  // agent_47's claim 1140, but agent_12 is the one that actually settled money
  // today. The derived total must drive the order.
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_12", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 700, execution: settled("d1"), facts: mkFacts({ daily_total_so_far: 200 }) }),
    mkView({ decisionId: "d2", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "allow", amount: 100, execution: settled("d2"), facts: mkFacts({ daily_total_so_far: 1140 }) }),
  ];
  const summaries = summarizeAgents(rows, NOW);
  assert.deepEqual(summaries.map((s) => s.agentId), ["agent_12", "agent_47"]);
});

test("fleet ties on derived total break deterministically by agent id", () => {
  const rows = [
    mkView({ decisionId: "d1", agentId: "agent_47", ts: "2026-07-15 09:00:00", outcome: "deny", status: "denied", execution: null }),
    mkView({ decisionId: "d2", agentId: "agent_12", ts: "2026-07-15 09:00:00", outcome: "deny", status: "denied", execution: null }),
  ];
  const summaries = summarizeAgents(rows, NOW);
  assert.deepEqual(summaries.map((s) => s.agentId), ["agent_12", "agent_47"]);
});

test("an agent with no facts has NULL policy config — limits are never invented", () => {
  // Config genuinely is unknown without facts, so it stays null (the card then
  // omits the denominator and the bar rather than guessing a limit).
  const rows = [mkView({ decisionId: "d1", agentId: "agent_47", facts: null })];
  const [a47] = summarizeAgents(rows);
  assert.ok(a47);
  assert.equal(a47.perTxnCap, null);
  assert.equal(a47.dailyLimit, null);
  assert.deepEqual(a47.clearedCategories, []);
});

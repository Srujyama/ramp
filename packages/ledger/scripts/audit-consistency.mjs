#!/usr/bin/env node
/**
 * The ledger's internal consistency audit — packages/ledger/scripts/audit-consistency.mjs
 *
 * `scripts/audit.mjs` at the repo root asks: "does each sealed bundle re-derive?"
 * It reads JSON files and brings its own kernel. This asks the OTHER half of the
 * question, the one a per-decision proof structurally cannot answer:
 *
 *   Is the LEDGER AS A WHOLE consistent with the claim the product makes about it?
 *
 * The claim is that every figure on the dashboard is derived from the decision log
 * and independently verifiable — that money moved if and only if the kernel allowed
 * it and the executor settled it, and that no other number exists anywhere to
 * disagree. That claim is not provable one decision at a time. A set of perfectly
 * verifying proofs is still a lie if a deny got settled, if a total is summed from
 * a table nothing writes, or if a stored verdict does not follow from its own facts.
 *
 * So this program re-derives the totals two ways and compares, re-runs the REAL
 * kernel over every stored decision's own recorded facts, and asserts the
 * invariants that only hold across rows. It trusts no stored aggregate.
 *
 * READ-ONLY BY CONSTRUCTION: opens with `provisionIfEmpty: false` and issues
 * nothing but SELECTs. An auditor that provisions or heals the thing it is
 * auditing is not an auditor. If the DB is empty or unprovisioned, that is a
 * finding to report, not a condition to fix.
 *
 *   pnpm --filter @ramp/ledger audit:consistency
 *   RAMP_DB_PATH=/path/to/ramp.db pnpm --filter @ramp/ledger audit:consistency
 *
 * Exit code is 1 if ANY check fails, so CI can gate on it.
 */
import {
  openLedger,
  closeLedger,
  verifyChain,
  verifyDecisionProof,
  makeFactSource,
  digestOf,
} from "../dist/src/index.js";
import { referenceKernel } from "@ramp/gate";

// ---------------------------------------------------------------------------
// The derivation under audit.
// ---------------------------------------------------------------------------
// Spend is `ledger_entries` now, not the decision log: the DAL sums that table for
// every windowed total it reads (src/dal.ts LEDGER_QUERIES — dailyTotalSoFar,
// recentTxnCount, duplicateCount, #spentFor). A settled+allow decision AUTOMATICALLY
// projects one `ledger_entries` row (recordExecution, src/decision-log.ts), and the
// base seed writes a handful of direct fixture rows (agent_47's calibrated 1140, the
// burst/travel/dup demo rows) that have NO decision behind them on purpose.
//
// So this audit's job splits in two: (1) the DAL's spend reads reconcile with an
// independent JS walk of the SAME table, and (2) `ledger_entries` is a FAITHFUL
// PROJECTION of the decision log — every settled+allow decision has exactly one row,
// and every row is either such a projection or a base-seed fixture. The `FROM`
// fragment below is the DAL's today-window, repeated ON PURPOSE rather than imported:
// a check that imports the query it checks agrees with it by construction. Check B4
// additionally cross-examines the shipped DAL through its public API, so if this copy
// ever drifts from the real one, B4 says so.
const SETTLED_SPEND_TODAY = `
  FROM ledger_entries
  WHERE date(ts) = date('now')
`;

/**
 * A `ledger_entries` row is a base-seed demo FIXTURE (no decision behind it) iff its
 * request_id carries the seed's `req_` prefix — req_seed_* (agent_47's calibrated
 * 1140), req_burst_*, req_trav_*, req_dup_seed. Every PROJECTED row instead carries
 * the request_id of the decision it came from (`inv_h*` from the history seeder,
 * `inv_*` from the enforcement path), so this prefix can never mask a real projection.
 */
const isSeedFixture = (requestId) => typeof requestId === "string" && requestId.startsWith("req_");

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const results = [];

/**
 * Record one check. `rows` are the OFFENDING rows and are printed only on
 * failure — a passing check that dumps its inputs teaches the reader to skim.
 */
function check(id, title, { pass, detail, rows = [] }) {
  results.push({ id, title, pass, detail, rows });
  console.log(`${pass ? "  OK  " : "! FAIL"} ${id}  ${title}`);
  console.log(`         ${detail}`);
  for (const row of rows.slice(0, 20)) console.log(`         → ${row}`);
  if (rows.length > 20) console.log(`         → …and ${rows.length - 20} more`);
}

function section(letter, title) {
  console.log(`\n${letter}. ${title}`);
  console.log("-".repeat(72));
}

/** Sum a list of numbers exactly. Money is integer whole units; never floats. */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Open the ledger. Read-only, never provision.
// ---------------------------------------------------------------------------
let db;
try {
  db = openLedger(process.env.RAMP_DB_PATH, { provisionIfEmpty: false });
} catch (err) {
  console.error(`\nCould not open the ledger: ${err.message}`);
  console.error(`This audit never provisions — an unreadable ledger is a finding.\n`);
  process.exit(1);
}

const all = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);

console.log("\n" + "=".repeat(72));
console.log("LEDGER CONSISTENCY AUDIT — re-deriving every total, re-running every verdict");
console.log("=".repeat(72));

// An UNPROVISIONED ledger is a finding, not a crash. Because this audit never
// provisions, opening a fresh/empty file leaves it without tables, and every
// check below would die on the first SELECT with a stack trace that reads like
// a bug in the auditor. It isn't: the ledger it was pointed at has no decision
// log to audit, which is a fact worth saying plainly and exiting 1 over.
{
  const required = ["decisions", "decision_executions", "decision_proofs", "policy_limits", "agents"];
  const present = new Set(
    all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name),
  );
  const missing = required.filter((t) => !present.has(t));
  if (missing.length > 0) {
    console.log(`\nThis ledger is NOT PROVISIONED — missing table(s): ${missing.join(", ")}.`);
    console.log(
      `Nothing here can be audited, and this program will not create what it is\n` +
        `meant to be checking. Provision it (\`pnpm --filter @ramp/ledger db:reset\`)\n` +
        `and populate it (\`db:history\`), then re-run.\n`,
    );
    closeLedger(db);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Load everything once, into plain JS. The independent walks below use THESE
// objects and never ask SQLite to aggregate for them.
// ---------------------------------------------------------------------------
function safeParse(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const decisions = all(`
  SELECT decision_id, request_id, status, outcome, agent_id, vendor_id, amount,
         category, kernel_id, facts_json, decision_json, seq, ts
    FROM decisions
   ORDER BY ts, decision_id
`).map((r) => ({
  ...r,
  amount: Number(r.amount),
  facts: safeParse(r.facts_json),
  decision: safeParse(r.decision_json),
}));

const executions = all(`
  SELECT decision_id, receipt_id, execution_id, status, provider, executed_at
    FROM decision_executions
`);
const execByDecision = new Map(executions.map((e) => [e.decision_id, e]));
for (const d of decisions) d.execution = execByDecision.get(d.decision_id) ?? null;

// `ledger_entries` is the spend table the dashboard sums (src/dal.ts). Loaded once
// into plain JS so the walks below can aggregate it themselves and never ask SQLite
// to do it for them.
const ledgerEntries = all(`
  SELECT entry_id, agent_id, vendor_id, category_id, amount, request_id, ts
    FROM ledger_entries
`).map((r) => ({ ...r, amount: Number(r.amount) }));

/** The single definition of "this decision moved money", used by every walk below. */
const isSettled = (d) => d.outcome === "allow" && d.execution?.status === "settled";

const today = one(`SELECT date('now') AS day`).day;
const settledToday = decisions.filter((d) => isSettled(d) && d.ts.slice(0, 10) === today);

console.log(
  `\nLedger: ${decisions.length} decision(s), ${executions.length} execution(s), ` +
    `today is ${today} (UTC, per SQLite).`,
);
if (decisions.length === 0) {
  console.log(
    `\nThe decision log is EMPTY. Every check below is vacuously true, which is not\n` +
      `the same as verified. Seed a ledger (\`pnpm --filter @ramp/ledger db:history\`)\n` +
      `and re-run before reading a pass here as evidence of anything.`,
  );
}

// ===========================================================================
section("A", "Money only moves on an allow");
// ===========================================================================
// The catastrophic case. Every other check in this file is about numbers being
// right; this one is about whether the gate is a gate at all. A settled deny is
// not a discrepancy to reconcile — it is the product's central claim being false.

const settledNonAllow = decisions.filter(
  (d) => d.execution?.status === "settled" && d.outcome !== "allow",
);
check("A1", "No settled execution on a decision the kernel did not allow", {
  pass: settledNonAllow.length === 0,
  detail: `${executions.filter((e) => e.status === "settled").length} settled execution(s); ${settledNonAllow.length} on a non-allow.`,
  rows: settledNonAllow.map(
    (d) => `${d.decision_id} outcome=${d.outcome} amount=${d.amount} receipt=${d.execution.receipt_id}`,
  ),
});

const settledError = decisions.filter(
  (d) => d.execution?.status === "settled" && d.status === "error",
);
check("A2", "No settled execution on a decision recorded as an error", {
  pass: settledError.length === 0,
  detail: `${decisions.filter((d) => d.status === "error").length} error row(s); ${settledError.length} settled.`,
  rows: settledError.map((d) => `${d.decision_id} status=error amount=${d.amount}`),
});

// ===========================================================================
section("B", "Spend derivation reconciles (ledger_entries: SQL vs walk vs shipped DAL)");
// ===========================================================================
// The dal sums today's spend from `ledger_entries` in SQLite. Here we sum the SAME
// table again in JS, from rows SQLite was never asked to aggregate, and compare.
// They must agree exactly — not approximately: money is integer whole units precisely
// so that "close" is never a passing answer.

const entriesToday = ledgerEntries.filter((e) => e.ts.slice(0, 10) === today);

/** Compare a SQL-derived map against a JS-derived one, keyed by scope value. */
function reconcile(id, title, scopeColumn, keyOf) {
  const sqlRows = all(`
    SELECT ${scopeColumn} AS k, COALESCE(SUM(amount), 0) AS total
    ${SETTLED_SPEND_TODAY}
    GROUP BY ${scopeColumn}
  `);
  const fromSql = new Map(sqlRows.map((r) => [r.k, Number(r.total)]));

  const fromWalk = new Map();
  for (const e of entriesToday) {
    const k = keyOf(e);
    fromWalk.set(k, (fromWalk.get(k) ?? 0) + e.amount);
  }

  const keys = [...new Set([...fromSql.keys(), ...fromWalk.keys()])].sort();
  const mismatches = keys
    .filter((k) => (fromSql.get(k) ?? 0) !== (fromWalk.get(k) ?? 0))
    .map((k) => `${k}: sql=${fromSql.get(k) ?? 0} walk=${fromWalk.get(k) ?? 0}`);

  check(id, title, {
    pass: mismatches.length === 0,
    detail:
      `${keys.length} ${scopeColumn.replace("_id", "")}(s) with spend today; ` +
      `total ${sum([...fromWalk.values()])}.`,
    rows: mismatches,
  });
}

reconcile("B1", "Per-agent spend today: dal query == independent walk", "agent_id", (e) => e.agent_id);
reconcile("B2", "Per-category spend today: dal query == independent walk", "category_id", (e) => e.category_id);
reconcile("B3", "Per-vendor spend today: dal query == independent walk", "vendor_id", (e) => e.vendor_id);

// The check above proves the auditor's COPY of the query agrees with the walk.
// It cannot notice that the copy has drifted from the query the enforcement path
// actually runs — which is the number that decides whether a payment goes
// through. So ask the shipped DAL itself, through its public API.
{
  const registered = all(`SELECT agent_id FROM agents ORDER BY agent_id`).map((r) => r.agent_id);
  const source = makeFactSource(db);
  const mismatches = [];
  for (const agentId of registered) {
    const fromDal = source.getDailyTotalSoFar(agentId);
    const fromWalk = sum(entriesToday.filter((e) => e.agent_id === agentId).map((e) => e.amount));
    if (fromDal !== fromWalk) mismatches.push(`${agentId}: dal=${fromDal} walk=${fromWalk}`);
  }
  check("B4", "The SHIPPED dal (getDailyTotalSoFar) agrees with the ledger walk", {
    pass: mismatches.length === 0,
    detail: `${registered.length} registered agent(s) queried through LedgerFactSource.`,
    rows: mismatches,
  });

  // An agent that spends but is not in the registry would be summed by the walk
  // and REFUSED by the DAL (UnknownAgentError) — the two disagree, and the DAL is
  // right to. Surfaced separately so B4 stays a clean equality check. Both the
  // decision log AND the spend table are scanned: a ledger row for a ghost agent is
  // spend the dashboard would show and the DAL would refuse to explain.
  const known = new Set(registered);
  const ghosts = [
    ...new Set(
      [
        ...decisions.filter((d) => !known.has(d.agent_id)).map((d) => d.agent_id),
        ...ledgerEntries.filter((e) => !known.has(e.agent_id)).map((e) => e.agent_id),
      ],
    ),
  ];
  check("B5", "Every decision and ledger row names an agent in the registry", {
    pass: ghosts.length === 0,
    detail: `${ghosts.length} unregistered agent(s) appear in the decision log or ledger.`,
    rows: ghosts.map((a) => `${a}: rows exist, no row in \`agents\` — the DAL refuses to serve it facts`),
  });
}

// ---- The projection is faithful: ledger_entries <-> settled+allow decisions ------
// Spend is `ledger_entries`, but the CLAIM is that a row lands there if and only if
// the kernel allowed a decision and the executor settled it — the projection
// recordExecution performs (src/decision-log.ts). B4 proves the totals add up; it is
// blind to a ledger row conjured with no decision behind it, or a settled decision
// that never made it into spend. So match the two sets row for row on the fields the
// projection copies (agent, vendor, category, amount, request_id), counting
// multiplicity so a duplicated row cannot hide behind an equal sum.
{
  const projKey = (agent, vendor, category, amount, requestId) =>
    `${agent}|${vendor}|${category}|${amount}|${requestId ?? ""}`;

  const settledAllow = decisions.filter(isSettled);
  const decCounts = new Map();
  for (const d of settledAllow) {
    const k = projKey(d.agent_id, d.vendor_id, d.category, d.amount, d.request_id);
    decCounts.set(k, (decCounts.get(k) ?? 0) + 1);
  }

  // Base-seed fixtures (req_*) are decision-less demo data by design — exempt.
  const projectedEntries = ledgerEntries.filter((e) => !isSeedFixture(e.request_id));
  const fixtureCount = ledgerEntries.length - projectedEntries.length;
  const entryCounts = new Map();
  for (const e of projectedEntries) {
    const k = projKey(e.agent_id, e.vendor_id, e.category_id, e.amount, e.request_id);
    entryCounts.set(k, (entryCounts.get(k) ?? 0) + 1);
  }

  const missing = [];
  for (const [k, n] of decCounts) {
    const m = entryCounts.get(k) ?? 0;
    if (m < n) missing.push(`${k} — ${n} settled decision(s) but only ${m} ledger row(s)`);
  }
  check("B6", "Every settled+allow decision projects a matching ledger_entries row", {
    pass: missing.length === 0,
    detail:
      `${settledAllow.length} settled+allow decision(s) vs ${projectedEntries.length} projected ledger ` +
      `row(s) (${fixtureCount} base-seed fixture(s) exempt).`,
    rows: missing,
  });

  const orphans = [];
  for (const [k, n] of entryCounts) {
    const m = decCounts.get(k) ?? 0;
    if (n > m) orphans.push(`${k} — ${n} ledger row(s) but only ${m} settled decision(s)`);
  }
  check("B7", "No ledger_entries row without a settled+allow decision (base-seed fixtures exempt)", {
    pass: orphans.length === 0,
    detail:
      `${projectedEntries.length} projected row(s) checked; a row with no decision behind it is spend ` +
      `nothing authorised.`,
    rows: orphans,
  });
}

// ===========================================================================
section("C", "Denied / held / not-executed contribute ZERO spend");
// ===========================================================================
// The interesting direction. B proves the settled rows add up; it says nothing
// about what was LEFT OUT. A total that quietly counted an escalation would
// reconcile perfectly with itself. So partition the ENTIRE log by why each row
// does or does not count, and prove the parts add back to the whole.

const settledAll = decisions.filter(isSettled);
const excluded = decisions.filter((d) => !isSettled(d));

const lifetimeAll = sum(decisions.map((d) => d.amount));
const lifetimeSettled = sum(settledAll.map((d) => d.amount));
const lifetimeExcluded = sum(excluded.map((d) => d.amount));

check("C1", "sum(all decisions) − sum(settled) == sum(excluded), exactly", {
  pass: lifetimeAll - lifetimeSettled === lifetimeExcluded,
  detail: `all=${lifetimeAll} settled=${lifetimeSettled} excluded=${lifetimeExcluded} (difference ${lifetimeAll - lifetimeSettled}).`,
  rows:
    lifetimeAll - lifetimeSettled === lifetimeExcluded
      ? []
      : [`spend is unaccounted for: ${lifetimeAll - lifetimeSettled - lifetimeExcluded} units belong to neither side`],
});

// Name each excluded row's reason, and require the reasons to partition it: every
// excluded row has exactly one, and the reasons' amounts add back to the total.
// "Excluded" with no sayable reason is how a real leak would look.
const reasonOf = (d) => {
  if (d.outcome === "deny") return "denied (kernel said no)";
  if (d.outcome === "escalate") return "escalated (held for a human, never paid)";
  if (d.outcome === null) return "error (no verdict recorded)";
  if (d.execution === null) return "allowed, never executed";
  if (d.execution.status === "failed") return "allowed, executor failed";
  return "UNCLASSIFIED";
};
const byReason = new Map();
for (const d of excluded) {
  const r = reasonOf(d);
  const cur = byReason.get(r) ?? { count: 0, amount: 0 };
  byReason.set(r, { count: cur.count + 1, amount: cur.amount + d.amount });
}
const unclassified = excluded.filter((d) => reasonOf(d) === "UNCLASSIFIED");
check("C2", "Every excluded decision has exactly one named reason for not counting", {
  pass: unclassified.length === 0 && sum([...byReason.values()].map((v) => v.amount)) === lifetimeExcluded,
  detail:
    `${excluded.length} excluded decision(s), ${lifetimeExcluded} units: ` +
    ([...byReason.entries()].map(([r, v]) => `${v.count}× ${r} (${v.amount})`).join("; ") || "none"),
  rows: unclassified.map((d) => `${d.decision_id} outcome=${d.outcome} exec=${d.execution?.status ?? "none"}`),
});

// The direct form of the claim: today's spend total (the dashboard's number, summed
// from `ledger_entries`) accounts for exactly two legitimate sources — the settled
// decisions projected today and the base-seed fixtures — and no excluded decision
// leaked into it. Recompute all three independently and confirm they close.
{
  const excludedToday = decisions.filter((d) => !isSettled(d) && d.ts.slice(0, 10) === today);
  const sqlToday = Number(one(`SELECT COALESCE(SUM(amount), 0) AS total ${SETTLED_SPEND_TODAY}`).total);
  const ledgerToday = sum(entriesToday.map((e) => e.amount));
  const fixturesToday = sum(entriesToday.filter((e) => isSeedFixture(e.request_id)).map((e) => e.amount));
  const settledDecToday = sum(settledToday.map((d) => d.amount));
  const excludedTodayAmt = sum(excludedToday.map((d) => d.amount));
  const closes = sqlToday === ledgerToday && ledgerToday === settledDecToday + fixturesToday;
  check("C3", "Today's total counts settled spend + base-seed fixtures and nothing else", {
    pass: closes,
    detail:
      `today: ${ledgerToday} = ${settledDecToday} settled-decision projection + ${fixturesToday} base-seed ` +
      `fixture(s); ${excludedToday.length} excluded decision(s) worth ${excludedTodayAmt} units are NOT in it ` +
      `(a total that counted them would read ${ledgerToday + excludedTodayAmt}).`,
    rows: closes
      ? []
      : [`sql=${sqlToday} ledger=${ledgerToday} settled=${settledDecToday} fixtures=${fixturesToday}`],
  });
}

// ===========================================================================
section("D", "Identity + integrity");
// ===========================================================================

const dupDecisionIds = all(`
  SELECT decision_id, COUNT(*) AS c FROM decisions GROUP BY decision_id HAVING c > 1
`);
check("D1", "No duplicate decision_id", {
  pass: dupDecisionIds.length === 0,
  detail: `${decisions.length} decision(s), ${new Set(decisions.map((d) => d.decision_id)).size} distinct id(s).`,
  rows: dupDecisionIds.map((r) => `${r.decision_id} appears ${r.c}×`),
});

const dupSeq = all(`
  SELECT seq, COUNT(*) AS c FROM decisions WHERE seq IS NOT NULL GROUP BY seq HAVING c > 1
`);
check("D2", "No duplicate seq (two rows claiming one position is a fork, not a log)", {
  pass: dupSeq.length === 0,
  detail: `${decisions.filter((d) => d.seq !== null).length} chained decision(s).`,
  rows: dupSeq.map((r) => `position ${r.seq} claimed by ${r.c} decisions`),
});

// Unchained rows are legitimate (they predate the chain) but they are NOT covered
// by it, and a chain that verifies while half the log sits outside it is a
// statement about the half. Report the number rather than let a green D4 imply
// coverage it does not have.
const unchained = decisions.filter((d) => d.seq === null);
check("D3", "Every decision is IN the chain (no NULL seq)", {
  pass: unchained.length === 0,
  detail: `${unchained.length} of ${decisions.length} decision(s) carry no chain link; verifyChain cannot see them.`,
  rows: unchained.map((d) => `${d.decision_id} ts=${d.ts} — outside the chain`),
});

const chain = verifyChain(db);
check("D4", "The hash chain is intact (verifyChain)", {
  pass: chain.valid,
  detail: chain.valid
    ? `no decision was edited, deleted, reordered, or inserted.`
    : `${chain.defects.length} defect(s).`,
  rows: chain.defects.map((d) => `[${d.kind}] seq ${d.seq}: ${d.detail}`),
});

// Independent proof re-verification — the same call the HTTP bridge makes per row
// (see src/http-bridge.ts), recomputing each proof's id from its CURRENT content
// rather than believing the id stored beside it.
{
  const proofRows = all(`SELECT decision_id, proof_json FROM decision_proofs`);
  const failures = [];
  for (const row of proofRows) {
    const v = verifyDecisionProof({ proof: safeParse(row.proof_json) });
    if (!v.proofVerified) {
      failures.push(
        `${row.decision_id} [${v.reason}] expected=${v.expectedProofId ?? "?"} stored=${v.actualProofId ?? "?"}`,
      );
    }
  }
  check("D5", "Every stored proof independently re-verifies", {
    pass: failures.length === 0,
    detail: `${proofRows.length} proof(s) recomputed from their own content.`,
    rows: failures,
  });

  const withProof = new Set(proofRows.map((r) => r.decision_id));
  const proofless = decisions.filter((d) => !withProof.has(d.decision_id));
  check("D6", "Every decision has a proof", {
    pass: proofless.length === 0,
    detail: `${proofless.length} decision(s) have no proof row — nothing to re-verify for them.`,
    rows: proofless.map((d) => `${d.decision_id} status=${d.status} outcome=${d.outcome ?? "none"}`),
  });
}

// ---- The proof must be bound to the ROW, not merely to itself ---------------
// D5 recomputes each proof's id from the proof's own content, which is exactly
// what verifyProof promises — and it is blind by construction to the row the
// proof is ABOUT. Editing `decisions.facts_json` leaves the proof internally
// perfect: it still hashes to its stored id, because nothing in it changed. The
// proof carries a `factsDigest` of the facts it was built from, so the edit is
// detectable, but ONLY by a check that reads both sides and compares. That is
// this check. Verified against this ledger: a tampered facts_json passes D4 and
// D5 and fails here.
{
  const bound = all(`
    SELECT d.decision_id, d.facts_json, d.decision_json, p.proof_json
      FROM decisions d JOIN decision_proofs p ON p.decision_id = d.decision_id
  `);
  const factsDrift = [];
  const verdictDrift = [];
  for (const row of bound) {
    const proof = safeParse(row.proof_json);
    if (proof === null) continue; // D5 already reports an unparseable proof.

    const facts = safeParse(row.facts_json);
    const expected = facts === null ? null : digestOf(facts);
    if (expected !== (proof.factsDigest ?? null)) {
      factsDrift.push(
        `${row.decision_id} facts_json digests to ${expected ?? "<absent>"} but its proof commits to ${proof.factsDigest ?? "<absent>"}`,
      );
    }

    const stored = safeParse(row.decision_json);
    const storedVerdict = stored?.decision ?? null;
    const provenVerdict = proof.decision?.decision ?? null;
    if (storedVerdict !== provenVerdict) {
      verdictDrift.push(
        `${row.decision_id} row says ${storedVerdict ?? "<none>"}, its own proof says ${provenVerdict ?? "<none>"}`,
      );
    }
  }
  check("D7", "Each decision's facts match the factsDigest its proof commits to", {
    pass: factsDrift.length === 0,
    detail: `${bound.length} proof(s) compared against the row they attest — the binding verifyProof cannot see.`,
    rows: factsDrift,
  });
  check("D8", "Each decision's stored verdict matches the verdict in its own proof", {
    pass: verdictDrift.length === 0,
    detail: `${bound.length} proof(s) compared against their decision row.`,
    rows: verdictDrift,
  });

  const misfiled = bound.filter((r) => (safeParse(r.proof_json)?.decisionId ?? null) !== r.decision_id);
  check("D9", "Every proof names the decision it is filed under", {
    pass: misfiled.length === 0,
    detail: `${bound.length} proof(s) checked; a proof filed against another decision proves that other decision.`,
    rows: misfiled.map((r) => `${r.decision_id} holds a proof for ${safeParse(r.proof_json)?.decisionId ?? "<none>"}`),
  });
}

for (const [id, column] of [
  ["D10", "receipt_id"],
  ["D11", "execution_id"],
]) {
  const dups = all(`
    SELECT ${column} AS v, COUNT(*) AS c FROM decision_executions GROUP BY ${column} HAVING c > 1
  `);
  check(id, `No duplicate ${column} across executions`, {
    pass: dups.length === 0,
    detail: `${executions.length} execution(s), ${new Set(executions.map((e) => e[column])).size} distinct ${column}(s).`,
    rows: dups.map((r) => `${r.v} used by ${r.c} executions — one receipt cannot be two payments`),
  });
}

// ===========================================================================
section("E", "Timestamps");
// ===========================================================================

const future = all(`SELECT decision_id, ts FROM decisions WHERE ts > datetime('now') ORDER BY ts DESC`);
check("E1", "No decision timestamped in the future", {
  pass: future.length === 0,
  detail: `now is ${one(`SELECT datetime('now') AS n`).n} (UTC).`,
  rows: future.map((r) => `${r.decision_id} ts=${r.ts} — recorded before it happened`),
});

const beforeDecision = all(`
  SELECT e.decision_id, e.executed_at, d.ts
    FROM decision_executions e JOIN decisions d ON d.decision_id = e.decision_id
   WHERE e.executed_at < d.ts
`);
check("E2", "No execution precedes the decision that authorized it", {
  pass: beforeDecision.length === 0,
  detail: `${executions.length} execution(s) compared against their decision's ts.`,
  rows: beforeDecision.map(
    (r) => `${r.decision_id} executed_at=${r.executed_at} < decision ts=${r.ts} — money moved first`,
  ),
});

// `datetime()` returns NULL for anything it cannot parse, which is how an
// unparseable ts hides: `date(ts) = date('now')` is simply never true, so the row
// silently drops out of every total instead of erroring.
const badTs = all(`
  SELECT decision_id, ts, NULL AS executed_at FROM decisions WHERE datetime(ts) IS NULL
  UNION ALL
  SELECT decision_id, NULL AS ts, executed_at FROM decision_executions WHERE datetime(executed_at) IS NULL
`);
check("E3", "Every ts / executed_at parses as a SQLite datetime", {
  pass: badTs.length === 0,
  detail: `${decisions.length + executions.length} timestamp(s) parsed; an unparseable one drops out of every total in silence.`,
  rows: badTs.map((r) => `${r.decision_id} ${r.ts !== null ? `ts=${r.ts}` : `executed_at=${r.executed_at}`} — unparseable`),
});

// ===========================================================================
section("F", "Impossible policy states");
// ===========================================================================
// Each check below judges a settled decision against ITS OWN recorded facts —
// not against today's policy_limits row. That distinction is the point: policy
// changes, and a decision made under last week's cap is not wrong because the
// cap moved. A decision that violated the cap IT WAS JUDGED UNDER is wrong
// forever, and no later edit to policy can make it right.

/** Settled decisions that recorded facts we can judge them against. */
const settledWithFacts = settledAll.filter((d) => d.facts !== null);
const settledNoFacts = settledAll.filter((d) => d.facts === null);

function policyCheck(id, title, predicate, describe) {
  const bad = settledWithFacts.filter(predicate);
  check(id, title, {
    pass: bad.length === 0,
    detail: `${settledWithFacts.length} settled decision(s) judged against their own recorded facts.`,
    rows: bad.map(describe),
  });
}

policyCheck(
  "F1",
  "No settled decision exceeds the per_txn_cap in its own facts",
  (d) => d.amount > d.facts.per_txn_cap,
  (d) => `${d.decision_id} amount=${d.amount} > per_txn_cap=${d.facts.per_txn_cap} — settled anyway`,
);

policyCheck(
  "F2",
  "No settled decision exceeds its own escalation_threshold (a held payment never settles)",
  (d) => d.amount > d.facts.escalation_threshold,
  (d) =>
    `${d.decision_id} amount=${d.amount} > escalation_threshold=${d.facts.escalation_threshold} — should have been held for a human`,
);

policyCheck(
  "F3",
  "No settled decision paid a vendor its own facts record as unverified",
  (d) => d.facts.vendor_verified !== true,
  (d) => `${d.decision_id} vendor=${d.vendor_id} vendor_verified=${d.facts.vendor_verified} — paid anyway`,
);

policyCheck(
  "F4",
  "No settled decision spent in a category its own facts record as unapproved",
  (d) => !(d.facts.approved_categories ?? []).includes(d.facts.category),
  (d) => `${d.decision_id} category=${d.facts.category} ∉ approved_categories=[${(d.facts.approved_categories ?? []).join(", ")}]`,
);

policyCheck(
  "F5",
  "No settled decision spent in a category its agent was not cleared for",
  (d) => !(d.facts.agent_cleared_categories ?? []).includes(d.facts.category),
  (d) =>
    `${d.decision_id} agent=${d.agent_id} category=${d.facts.category} ∉ agent_cleared_categories=[${(d.facts.agent_cleared_categories ?? []).join(", ")}]`,
);

check("F6", "Every settled decision recorded the facts it was judged on", {
  pass: settledNoFacts.length === 0,
  detail: `${settledNoFacts.length} settled decision(s) stored no facts — unjudgeable by F1–F5, and unprovable by anyone.`,
  rows: settledNoFacts.map((d) => `${d.decision_id} amount=${d.amount} — settled with no recorded facts`),
});

// ---- F7: the big one ------------------------------------------------------
// Re-run the REAL kernel over every stored decision's own recorded facts and
// compare the verdict it returns against the verdict the ledger stored. This is
// what separates "we logged a decision" from "the decision is derivable": a log
// is a claim by the system about the system, and you must already trust the
// system to believe it. Re-deriving needs no such trust — if a verdict was
// fabricated, edited, or produced by a kernel that has since changed its mind,
// the two disagree here and nowhere else.
{
  const judged = decisions.filter((d) => d.facts !== null && d.decision !== null);
  const unjudgeable = decisions.filter((d) => d.facts === null || d.decision === null);
  const mismatches = [];
  for (const d of judged) {
    let expected;
    try {
      expected = referenceKernel.evaluate(d.facts).decision;
    } catch (err) {
      mismatches.push(`${d.decision_id} expected=<kernel threw: ${err.message}> actual=${d.decision.decision}`);
      continue;
    }
    if (expected !== d.decision.decision) {
      mismatches.push(
        `${d.decision_id} expected=${expected} actual=${d.decision.decision} ` +
          `(agent=${d.agent_id} vendor=${d.vendor_id} amount=${d.amount} category=${d.category} kernel=${d.kernel_id ?? "?"})`,
      );
    }
  }
  check("F7", "Every stored verdict re-derives from its own facts (referenceKernel)", {
    pass: mismatches.length === 0,
    detail: `${judged.length} decision(s) re-evaluated with the real kernel; ${unjudgeable.length} lacked facts or a verdict to compare.`,
    rows: mismatches,
  });

  check("F8", "Every decision recorded both the facts and the verdict", {
    pass: unjudgeable.length === 0,
    detail: `${unjudgeable.length} decision(s) cannot be re-derived by anyone — the audit trail is incomplete for them.`,
    rows: unjudgeable.map(
      (d) => `${d.decision_id} status=${d.status} facts=${d.facts ? "present" : "MISSING"} decision=${d.decision ? "present" : "MISSING"}`,
    ),
  });
}

// ===========================================================================
section("G", "Reconciliation across periods");
// ===========================================================================
// Partitioning by period must lose nothing. If the daily buckets do not add back
// to the lifetime total, then a decision belongs to no day — which means some
// period view on the dashboard is silently dropping it, and the number a person
// reads depends on which page they opened.

function partitionCheck(id, title, expr) {
  const buckets = all(`
    SELECT ${expr} AS bucket, COALESCE(SUM(d.amount), 0) AS total
      FROM decisions d
      JOIN decision_executions e ON e.decision_id = d.decision_id
     WHERE d.outcome = 'allow' AND e.status = 'settled'
     GROUP BY bucket
  `);
  const bucketed = sum(buckets.map((b) => Number(b.total)));
  const orphaned = buckets.filter((b) => b.bucket === null);
  check(id, title, {
    pass: bucketed === lifetimeSettled && orphaned.length === 0,
    detail: `${buckets.length} bucket(s) summing to ${bucketed}; lifetime settled is ${lifetimeSettled}.`,
    rows: [
      ...(bucketed === lifetimeSettled ? [] : [`buckets lose ${lifetimeSettled - bucketed} units against lifetime`]),
      ...orphaned.map((b) => `${Number(b.total)} units fall in NO bucket — an unparseable ts`),
    ],
  });
}

partitionCheck("G1", "sum(daily buckets) == lifetime settled", "date(d.ts)");
partitionCheck("G2", "sum(weekly buckets) == lifetime settled", "strftime('%Y-%W', d.ts)");
partitionCheck("G3", "sum(monthly buckets) == lifetime settled", "strftime('%Y-%m', d.ts)");

// The period VIEWS (today / this week / this month) are nested windows over the
// same log, so they must nest: a figure for today larger than the figure for the
// month containing it is not a rounding difference, it is two different logs.
{
  const windowTotal = (predicate) => sum(settledAll.filter(predicate).map((d) => d.amount));
  const day = windowTotal((d) => d.ts.slice(0, 10) === today);
  const month = windowTotal((d) => d.ts.slice(0, 7) === today.slice(0, 7));
  const week = windowTotal((d) => {
    const bucket = one(`SELECT strftime('%Y-%W', ?) AS b`, d.ts).b;
    return bucket === one(`SELECT strftime('%Y-%W', 'now') AS b`).b;
  });
  const nested = day <= week && week <= month && month <= lifetimeSettled;
  check("G4", "Period windows nest: today ≤ week ≤ month ≤ lifetime", {
    pass: nested,
    detail: `today=${day} week=${week} month=${month} lifetime=${lifetimeSettled}.`,
    rows: nested ? [] : [`a narrower window reports MORE spend than the window containing it`],
  });
}

closeLedger(db);

// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(72));
const failed = results.filter((r) => !r.pass);
if (failed.length === 0 && decisions.length === 0) {
  // The most dangerous output this program could print is a clean bill of health
  // over an empty log — "all checks passed" is exactly the string a reader trusts,
  // and every check above is vacuously true when there is nothing to check.
  // "I cannot assess this" and "this is fine" are different answers.
  console.log(
    `All ${results.length} check(s) passed VACUOUSLY — the decision log is empty.\n` +
      `This is NOT a clean bill of health. Nothing was verified because there was\n` +
      `nothing to verify. Populate the ledger and re-run.`,
  );
} else if (failed.length === 0) {
  console.log(
    `All ${results.length} check(s) PASSED across ${decisions.length} decision(s).\n` +
      `Every spend total re-derives from the decision log two independent ways,\n` +
      `every stored verdict follows from its own recorded facts under the real\n` +
      `kernel, and nothing settled that policy did not allow.`,
  );
} else {
  console.log(`${failed.length} of ${results.length} check(s) FAILED:`);
  for (const r of failed) console.log(`  ${r.id}  ${r.title}`);
  console.log(
    `\nThese are inconsistencies in the LEDGER, not in this program. Each one above\n` +
      `names the offending rows. Do not reconcile a total by adjusting the total.`,
  );
}
console.log("=".repeat(72) + "\n");

process.exit(failed.length === 0 ? 0 : 1);

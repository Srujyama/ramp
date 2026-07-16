#!/usr/bin/env node
/**
 * "Why?" — scripts/explain.mjs   (invoked as `pnpm explain`)
 *
 *   pnpm explain                 # explain the most recent STOPPED payment (deny or held)
 *   pnpm explain <decisionId>    # explain a specific decision from the log
 *   pnpm explain -- --json [id]  # machine-readable
 *   pnpm explain -- --list       # list recent stopped decisions to choose from
 *
 * NOTE the `--` before flags: pnpm intercepts bare `--json`/`--list` as its own
 * options, so pass them after `--`. A positional decision id needs no `--`.
 * (The command is `explain`, not `why`, because `pnpm why` is a pnpm builtin.)
 *
 * READ-ONLY. This never records a decision or moves money. It reads the exact
 * `Facts` and `Decision` the gate stored for a decision, hands them to the SAME
 * kernel that made the call, and prints two things:
 *
 *   1. WHY — every rule that fired, with the concrete numbers and the smallest
 *      change that would clear it.
 *   2. THE COUNTERFACTUAL — the largest amount that would have flipped the whole
 *      verdict to `allow`, found by PROBING THE KERNEL (never asserted). If a
 *      categorical fact is the blocker (unverified vendor, missing attestation),
 *      it says so plainly: no amount fixes that.
 *
 * This is the answer to a judge (or an auditor, or a finance lead) pointing at a
 * blocked payment and asking "why, and what would it have taken?" — answered by
 * the gate itself, not by a human guessing.
 */
import { openLedgerStrict, closeLedger, getDecision, listDecisions } from "@ramp/ledger";
import { getKernel, explainDecision } from "@ramp/gate";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const wantList = argv.includes("--list");
const idArg = argv.find((a) => !a.startsWith("--"));

const db = openLedgerStrict();

/** The most recent decision that STOPPED money (deny or held), for the no-arg case. */
function latestStopped() {
  const denied = listDecisions(db, { status: "denied", limit: 1 }).decisions[0];
  const held = listDecisions(db, { status: "escalated", limit: 1 }).decisions[0];
  if (denied && held) return denied.ts >= held.ts ? denied : held;
  return denied ?? held;
}

function fail(msg, code = 1) {
  process.stderr.write(`explain: ${msg}\n`);
  closeLedger(db);
  process.exit(code);
}

try {
  if (wantList) {
    const stopped = listDecisions(db, { limit: 200 }).decisions.filter(
      (d) => d.status === "denied" || d.status === "escalated",
    );
    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          stopped.map((d) => ({
            decisionId: d.decisionId,
            status: d.status,
            agent: d.agentId,
            vendor: d.vendorId,
            amount: d.amount,
            ts: d.ts,
          })),
          null,
          2,
        ) + "\n",
      );
    } else if (stopped.length === 0) {
      process.stdout.write("\n  No stopped payments yet. Run `pnpm demo` first.\n\n");
    } else {
      process.stdout.write("\n  STOPPED PAYMENTS (newest first) — pass an id to `pnpm explain <id>`\n");
      process.stdout.write("  " + "─".repeat(64) + "\n");
      for (const d of stopped.slice(0, 25)) {
        const tag = d.status === "denied" ? "DENY " : "HOLD ";
        process.stdout.write(
          `  ${tag} $${String(d.amount).padStart(5)}  ${d.vendorId.padEnd(14)} ${d.agentId.padEnd(12)} ${d.decisionId}\n`,
        );
      }
      process.stdout.write("\n");
    }
    closeLedger(db);
    process.exit(0);
  }

  const record = idArg ? getDecision(db, idArg) : latestStopped();
  if (!record) {
    fail(
      idArg
        ? `no decision with id "${idArg}" in the ledger. Try \`pnpm explain -- --list\`.`
        : "no stopped payments to explain yet. Run `pnpm demo` first.",
    );
  }
  if (record.corrupt || !record.facts || !record.decision) {
    fail(
      `decision "${record.decisionId}" has no evaluable facts/decision stored ` +
        `(status ${record.status})${record.corrupt ? " — the stored record is corrupt" : ""}.`,
    );
  }

  const { kernel } = getKernel();
  const explanation = explainDecision(record.facts, record.decision, kernel);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          decisionId: record.decisionId,
          status: record.status,
          agent: record.agentId,
          vendor: record.vendorId,
          amount: record.amount,
          category: record.category,
          ...explanation,
        },
        null,
        2,
      ) + "\n",
    );
    closeLedger(db);
    process.exit(0);
  }

  const money = (n) => `$${Number(n).toLocaleString()}`;
  const L = [];
  L.push("");
  L.push("  WHY DID THE GATE STOP THIS?");
  L.push("  " + "─".repeat(64));
  L.push(`  decision   ${record.decisionId}`);
  L.push(`  request    ${record.agentId} → ${record.vendorId}  ${money(record.amount)}  (${record.category})`);
  L.push(`  verdict    ${explanation.outcome.toUpperCase()}`);
  L.push("");
  L.push("  " + explanation.headline);

  if (explanation.firedRules.length) {
    L.push("");
    L.push("  RULES THAT FIRED  (and the smallest fix for each)");
    for (const r of explanation.firedRules) {
      L.push(`    • ${r.id}`);
      L.push(`        ${r.reason}`);
      L.push(`        fix: ${r.fix}`);
    }
  }

  const cf = explanation.counterfactual;
  L.push("");
  L.push("  COUNTERFACTUAL  (kernel-confirmed — the gate re-ran itself to check)");
  if (cf.maxAllowAmount !== null && cf.maxAllowAmount < record.amount) {
    L.push(`    would have SETTLED UNATTENDED at any amount ≤ ${money(cf.maxAllowAmount)}`);
    L.push(`    (it asked for ${money(record.amount)} — ${money(record.amount - cf.maxAllowAmount)} too much)`);
  } else if (cf.maxNonDenyAmount !== null && cf.maxNonDenyAmount < record.amount) {
    L.push(`    at ≤ ${money(cf.maxNonDenyAmount)} it would be HELD for a human rather than denied outright`);
    if (cf.categoricalBlockers.length) {
      L.push(`    but it still needs a person because: ${cf.categoricalBlockers.join(", ")}`);
    }
  } else {
    L.push("    no amount clears this — it is blocked on a categorical fact, not a number:");
    for (const b of cf.categoricalBlockers) L.push(`      · ${b}`);
    if (!cf.categoricalBlockers.length) L.push("      · policy requires a human review");
  }

  L.push("");
  L.push("  Verify the whole decision cryptographically:  pnpm proof");
  L.push("");
  process.stdout.write(L.join("\n") + "\n");
} finally {
  try {
    closeLedger(db);
  } catch {
    /* already closed on an early exit path */
  }
}

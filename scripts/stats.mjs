#!/usr/bin/env node
/**
 * The operator's view — scripts/stats.mjs
 *
 *   pnpm stats            # a snapshot of the gate's activity
 *   pnpm stats --json     # machine-readable
 *
 * READ-ONLY. Every query here is a SELECT — this never records a decision, moves
 * money, or resolves an escalation. It is the "what has the gate been doing?"
 * panel: how many payments it judged, how they split allow/hold/deny, which rules
 * are doing the catching, and what money was stopped.
 *
 * Two numbers matter most for the pitch, and they are the two this leads with:
 * money ALLOWED (what flowed) and money STOPPED (deny + held — what a wrong or
 * fraudulent payment would have cost, that didn't). "Save money" is not a slogan
 * here; it is a column.
 *
 * Built to survive an empty ledger: a fresh DB reports zeros, not a crash.
 */
import { openLedgerStrict, closeLedger, verifyChain, chainHead } from "@ramp/ledger";
import { money } from "./_lib.mjs";

const asJson = process.argv.slice(2).includes("--json");
const db = openLedgerStrict();

/** Safe scalar query — returns fallback on any error (missing table, etc.). */
function one(sql, params = [], fallback = 0) {
  try {
    const row = db.prepare(sql).get(...params);
    return row ? Object.values(row)[0] ?? fallback : fallback;
  } catch {
    return fallback;
  }
}
function rows(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

try {
  // ---- decision counts by status ---------------------------------------
  const byStatus = Object.fromEntries(
    rows("SELECT status, COUNT(*) AS n FROM decisions GROUP BY status").map((r) => [r.status, r.n]),
  );
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const allowed = byStatus.allowed ?? 0;
  const denied = byStatus.denied ?? 0;
  const escalated = byStatus.escalated ?? 0;
  const errored = byStatus.error ?? 0;

  // ---- money ------------------------------------------------------------
  // Allowed = money that flowed. Denied/held = money a bad decision would have
  // cost, that the gate stopped.
  const moneyAllowed = one(
    "SELECT COALESCE(SUM(amount),0) FROM decisions WHERE status = 'allowed'",
  );
  const moneyDenied = one(
    "SELECT COALESCE(SUM(amount),0) FROM decisions WHERE status = 'denied'",
  );
  const moneyHeld = one(
    "SELECT COALESCE(SUM(amount),0) FROM decisions WHERE status = 'escalated'",
  );

  // ---- what's doing the catching ---------------------------------------
  const topRules = rows(
    `SELECT rule_id, COUNT(*) AS n FROM decision_fired_rules
      WHERE rule_id LIKE 'deny/%' OR rule_id LIKE 'escalate/%'
      GROUP BY rule_id ORDER BY n DESC LIMIT 8`,
  );

  // ---- vendors / agents -------------------------------------------------
  const topVendors = rows(
    "SELECT vendor_id, COUNT(*) AS n FROM decisions GROUP BY vendor_id ORDER BY n DESC LIMIT 5",
  );

  // ---- held awaiting a human -------------------------------------------
  const pending = one(
    `SELECT COUNT(*) FROM decisions d
      LEFT JOIN decision_approvals a ON a.decision_id = d.decision_id
     WHERE d.status = 'escalated' AND a.decision_id IS NULL`,
  );
  const resolved = one("SELECT COUNT(*) FROM decision_approvals");

  // ---- chain / proof integrity -----------------------------------------
  const chain = verifyChain(db);
  const head = chainHead(db);
  const proofs = one("SELECT COUNT(*) FROM decision_proofs");

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          decisions: { total, allowed, denied, escalated, errored },
          money: { allowed: moneyAllowed, denied: moneyDenied, held: moneyHeld },
          topRules,
          topVendors,
          escalations: { pending, resolved },
          integrity: { chainValid: chain.valid, chainLength: head.length, proofs },
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }

  const bar = (n, max, width = 24) => {
    const filled = max > 0 ? Math.round((n / max) * width) : 0;
    return "█".repeat(filled) + "·".repeat(width - filled);
  };
  const pct = (n) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");

  const L = [];
  L.push("");
  L.push("  PROVABLE AGENT SPEND — gate activity");
  L.push("  " + "─".repeat(52));
  if (total === 0) {
    L.push("");
    L.push("  No decisions recorded yet. Run `pnpm demo` to populate the ledger.");
    L.push("");
    process.stdout.write(L.join("\n") + "\n");
    process.exit(0);
  }

  L.push("");
  L.push(`  ${total} decision(s) judged`);
  L.push(`    allowed    ${String(allowed).padStart(4)}  ${bar(allowed, total)}  ${pct(allowed)}`);
  L.push(`    held       ${String(escalated).padStart(4)}  ${bar(escalated, total)}  ${pct(escalated)}`);
  L.push(`    denied     ${String(denied).padStart(4)}  ${bar(denied, total)}  ${pct(denied)}`);
  if (errored) L.push(`    infra err  ${String(errored).padStart(4)}  ${bar(errored, total)}  ${pct(errored)}`);

  L.push("");
  L.push("  MONEY");
  L.push(`    flowed (allowed)     ${money(moneyAllowed)}`);
  L.push(`    STOPPED (deny+held)  ${money(moneyDenied + moneyHeld)}   <- what a wrong/fraud payment would have cost`);
  L.push(`      of which held for a human   ${money(moneyHeld)}`);
  L.push(`      of which flatly denied      ${money(moneyDenied)}`);

  if (topRules.length) {
    const maxR = topRules[0].n;
    L.push("");
    L.push("  WHAT'S CATCHING THINGS");
    for (const r of topRules) {
      L.push(`    ${r.rule_id.padEnd(34)} ${bar(r.n, maxR, 14)} ${r.n}`);
    }
  }

  L.push("");
  L.push("  ESCALATIONS");
  L.push(`    awaiting a human   ${pending}   (run \`pnpm approve\`)`);
  L.push(`    resolved           ${resolved}`);

  L.push("");
  L.push("  INTEGRITY");
  L.push(`    decision chain     ${chain.valid ? "INTACT" : "TAMPERED"}  (${head.length} links)`);
  L.push(`    proofs sealed      ${proofs}`);
  L.push(`    head               ${head.head.slice(0, 24)}…`);
  L.push("");
  L.push("  Verify it yourself:  pnpm proof   |   Publish the head:  pnpm head");
  L.push("");

  process.stdout.write(L.join("\n") + "\n");
} finally {
  closeLedger(db);
}

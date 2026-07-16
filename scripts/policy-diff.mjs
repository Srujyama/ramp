#!/usr/bin/env node
/**
 * Policy what-if — scripts/policy-diff.mjs   (invoked as `pnpm policy-diff`)
 *
 *   pnpm policy-diff -- --cap 300              # what if the per-txn cap were $300?
 *   pnpm policy-diff -- --daily 1200           # ...the daily limit $1200?
 *   pnpm policy-diff -- --threshold 250        # ...the human-approval threshold $250?
 *   pnpm policy-diff -- --velocity 4           # ...the velocity limit 4?
 *   pnpm policy-diff -- --cap 300 --daily 1200 # combine dials
 *   pnpm policy-diff -- --json                 # machine-readable
 *
 * "If we changed this dial, what would it have done to the payments we already
 * saw?" Answered by DETERMINISTIC REPLAY over the append-only decision log: each
 * decision's exact stored facts are re-judged by the real kernel with only the
 * named policy dials overridden — everything else (amount, vendor, clearances,
 * spend-so-far, attestation) held fixed. READ-ONLY: nothing is recorded, no dial
 * actually changes; this previews a policy edit, it does not make one.
 *
 * HONEST SCOPE: only the four scalar policy knobs move (cap, daily limit,
 * escalation threshold, velocity limit). Per-budget limits and categorical facts
 * (vendor verification, category approval, attestation) are NOT dials and are left
 * as recorded — see @ramp/gate reclassify.ts. (Named `policy-diff`; pnpm has no
 * builtin by that name.)
 */
import { openLedgerStrict, closeLedger, listDecisions } from "@ramp/ledger";
import { getKernel, reclassify, hasOverrides } from "@ramp/gate";
import { money } from "./_lib.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");

/** Parse `--flag value` pairs into policy overrides. */
function parseOverrides() {
  const map = { "--cap": "per_txn_cap", "--daily": "daily_limit", "--threshold": "escalation_threshold", "--velocity": "velocity_limit" };
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const key = map[argv[i]];
    if (!key) continue;
    const raw = argv[i + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      process.stderr.write(`policy-diff: ${argv[i]} needs a non-negative integer (got "${raw}")\n`);
      process.exit(1);
    }
    o[key] = n;
  }
  return o;
}

const overrides = parseOverrides();
if (!hasOverrides(overrides)) {
  process.stderr.write(
    "policy-diff: set at least one dial — --cap / --daily / --threshold / --velocity.\n" +
      "  e.g.  pnpm policy-diff -- --cap 300\n",
  );
  process.exit(1);
}

const db = openLedgerStrict();
try {
  const { kernel } = getKernel();
  // Walk the whole log (paginate). Only rows with evaluable facts + a real outcome.
  const all = [];
  let cursor;
  do {
    const page = listDecisions(db, { limit: 200, cursor });
    all.push(...page.decisions);
    cursor = page.nextCursor;
  } while (cursor);

  const judged = all.filter((d) => d.facts && d.outcome && !d.corrupt);

  // Transition matrix + money moved across the allow boundary.
  const transitions = {}; // "before→after" -> count
  const flips = []; // rows whose verdict changed
  let moneyNewlyStopped = 0; // was allow, now deny/escalate (money you'd now hold back)
  let moneyNewlyFreed = 0; // was deny/escalate, now allow (money that would now flow)

  for (const d of judged) {
    const r = reclassify(d.facts, d.outcome, overrides, kernel);
    const key = `${r.before}→${r.after}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    if (r.changed) {
      flips.push({ decisionId: d.decisionId, agent: d.agentId, vendor: d.vendorId, amount: d.amount, before: r.before, after: r.after });
      const nowStopped = r.before === "allow" && r.after !== "allow";
      const nowFreed = r.before !== "allow" && r.after === "allow";
      if (nowStopped) moneyNewlyStopped += d.amount;
      if (nowFreed) moneyNewlyFreed += d.amount;
    }
  }

  const summary = {
    overrides,
    evaluated: judged.length,
    changed: flips.length,
    transitions,
    money: { newlyStopped: moneyNewlyStopped, newlyFreed: moneyNewlyFreed },
    flips,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    process.exit(0);
  }

  const dialStr = Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const L = [];
  L.push("");
  L.push("  POLICY WHAT-IF — replaying the decision log under a hypothetical change");
  L.push("  " + "─".repeat(72));
  L.push(`  dials:      ${dialStr}`);
  L.push(`  evaluated:  ${judged.length} recorded decision(s)`);
  L.push(`  changed:    ${flips.length}`);
  if (judged.length === 0) {
    L.push("");
    L.push("  Nothing in the log yet. Run `pnpm demo` to populate it, then retry.");
    L.push("");
    process.stdout.write(L.join("\n") + "\n");
    process.exit(0);
  }

  L.push("");
  L.push("  MONEY IMPACT");
  L.push(`    would now be STOPPED (was allowed)   ${money(moneyNewlyStopped)}`);
  L.push(`    would now FLOW (was stopped/held)    ${money(moneyNewlyFreed)}`);

  const changedTransitions = Object.entries(transitions)
    .filter(([k]) => k.split("→")[0] !== k.split("→")[1])
    .sort((a, b) => b[1] - a[1]);
  if (changedTransitions.length) {
    L.push("");
    L.push("  TRANSITIONS");
    for (const [k, n] of changedTransitions) L.push(`    ${k.padEnd(22)} ${n}`);
  }

  if (flips.length) {
    L.push("");
    L.push("  WHAT FLIPPED");
    for (const f of flips.slice(0, 20)) {
      L.push(`    ${f.before} → ${f.after}   ${money(f.amount).padStart(7)}  ${String(f.agent).padEnd(11)} ${f.vendor}`);
    }
    if (flips.length > 20) L.push(`    …and ${flips.length - 20} more (use -- --json for all)`);
  }

  L.push("");
  L.push("  Read-only what-if. No dial was changed and nothing was recorded.");
  L.push("");
  process.stdout.write(L.join("\n") + "\n");
} finally {
  closeLedger(db);
}

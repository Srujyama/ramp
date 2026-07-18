/**
 * @ramp/ledger — seed-history CLI
 *
 * Thin wrapper around {@link seedDemoHistory} (src/demo-data.ts) — the generator
 * itself now lives in the package so the demo control plane's "Enable Dummy Data"
 * toggle can call it in-process against its own open `db` handle. This script owns
 * only what a one-shot CLI needs: opening/closing the DB and printing the report.
 *
 *   node packages/ledger/scripts/seed-history.mjs   # or: pnpm --filter @ramp/ledger db:history
 */
import { openLedger, closeLedger, seedDemoHistory } from "../dist/src/index.js";

const db = openLedger(process.env.RAMP_DB_PATH, { provisionIfEmpty: false });
const AGENT_DISPLAY_NAMES = {
  agent_47: "Procurement Agent 47",
  agent_12: "Ops Agent 12",
  agent_23: "Travel Agent 23",
  agent_08: "Eng Tools Agent 08",
};
const VENDOR_VERIFIED = {
  acme_corp: "trusted",
  globex_inc: "trusted",
  initech: "standard",
  newco_ltd: "elevated",
  sketchy_llc: "unverified",
  unknown_labs: "unverified",
};

const result = seedDemoHistory(db);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (n, d) => (d === 0 ? "0.0" : ((n / d) * 100).toFixed(1));
const total = result.outcome.allow + result.outcome.deny + result.outcome.escalate;

const past = result.perDay.filter((d) => !d.today);
const counts = past.map((d) => d.count);
const busiest = past.reduce((a, b) => (b.count > a.count ? b : a), past[0]);

console.log(
  `\nseed-history: wrote ${result.written} decisions (${result.skipped} already present) ` +
    `across ${result.perDay.length} days — ${past[0]?.date} … today\n`,
);

console.log("outcome mix");
for (const k of ["allow", "escalate", "deny"]) {
  console.log(`  ${k.padEnd(9)} ${String(result.outcome[k]).padStart(5)}  ${pct(result.outcome[k], total).padStart(5)}%`);
}
console.log(
  `  executions: ${result.settled} settled, ${result.failed} failed ` +
    `(${pct(result.failed, result.settled + result.failed)}% of attempts), ${result.pending} pending (today, in-flight)`,
);

console.log("\nper agent                     allow   held   deny    total");
for (const a of Object.keys(result.byAgent)) {
  const s = result.byAgent[a];
  const t = s.allow + s.deny + s.escalate;
  console.log(
    `  ${(`${AGENT_DISPLAY_NAMES[a] ?? a} (${a})`).padEnd(28)}` +
      `${String(s.allow).padStart(5)}${String(s.escalate).padStart(7)}${String(s.deny).padStart(7)}` +
      `${String(t).padStart(9)}  (${pct(s.allow, t)}% allowed)`,
  );
}

console.log("\nper vendor                    allow   held   deny    total");
for (const v of Object.keys(result.byVendor)) {
  const s = result.byVendor[v];
  const t = s.allow + s.deny + s.escalate;
  console.log(
    `  ${(`${v} [${VENDOR_VERIFIED[v] ?? "unknown"}]`).padEnd(28)}` +
      `${String(s.allow).padStart(5)}${String(s.escalate).padStart(7)}${String(s.deny).padStart(7)}` +
      `${String(t).padStart(9)}  (${pct(t, total)}% of traffic)`,
  );
}

console.log("\nfired rules");
for (const [r, n] of Object.entries(result.byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r.padEnd(38)} ${String(n).padStart(5)}`);
}

console.log("\nvolume");
console.log(`  days covered      ${result.perDay.length} (${result.days} backfilled + today)`);
console.log(`  per day           min ${Math.min(...counts)}, max ${Math.max(...counts)}, mean ${(counts.reduce((s, c) => s + c, 0) / counts.length).toFixed(1)}`);
console.log(`  busiest day       ${busiest.date} (${busiest.count})`);
console.log(`  today             ${result.perDay.at(-1).count} sampled, ${result.pending} allowed-in-flight, ${result.todaySettles} settled within headroom`);

console.log("\ntoday's derived spend (what the agent cards show)");
const CALIBRATED_AGENT = "agent_47";
for (const a of Object.keys(result.byAgent)) {
  const note = a === CALIBRATED_AGENT ? "  calibrated, must not move" : "";
  console.log(
    `  ${(`${AGENT_DISPLAY_NAMES[a] ?? a} (${a})`).padEnd(28)}${String(result.agentSettledToday[a]).padStart(6)}` +
      `   (baseline ${result.priorSpendSeen[a]})${note}`,
  );
}

console.log("\ninvariants");
console.log(`  chain             length ${result.chainLength}, head ${result.chainHead.slice(0, 20)}…, valid=${result.chainValid}`);
console.log(`  proofs verify     ${result.proofsChecked - result.badProofs}/${result.proofsChecked}`);
console.log(`  future-dated      ${result.futureDated}`);
console.log(
  `  ${CALIBRATED_AGENT} today    ${result.agentSettledToday[CALIBRATED_AGENT]} (must be exactly 1140)`,
);
for (const [category, settled] of Object.entries(result.categorySettledToday)) {
  const left = result.headroomLeft[category] ?? 0;
  console.log(`  ${category.padEnd(17)} ${String(settled).padStart(4)} settled today (${left} headroom unused)`);
}
console.log(
  `  today's baseline  ` +
    Object.entries(result.priorSpendSeen).map(([a, v]) => `${a}=${v}`).join(" ") +
    "  (base seed only, not this run's own rows)",
);

closeLedger(db);

if (result.problems.length > 0) {
  console.error("\nseed-history FAILED:");
  for (const p of result.problems) console.error(`  - ${p}`);
  if (!result.chainValid) console.error("chain defects:", result.chainDefects);
  process.exit(1);
}
console.log("\nseed-history: OK\n");

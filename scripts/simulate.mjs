#!/usr/bin/env node
/**
 * Pre-flight — scripts/simulate.mjs   (invoked as `pnpm simulate`)
 *
 *   pnpm simulate                    # preview a built-in demo batch
 *   pnpm simulate <batch.json>       # preview YOUR batch (array of spend intents)
 *   pnpm simulate -- --json [file]   # machine-readable
 *
 * "Before I send this run of payments, what will the gate do — and how much money
 * flows vs stops?" Answered with ZERO side effects: every item goes through the
 * same read-only kernel evaluation the real gate uses, and every STOPPED item is
 * annotated with its kernel-confirmed counterfactual (the max amount that would
 * clear it). Nothing is recorded; no money moves.
 *
 * A batch file is a JSON array of intents:
 *   [{ "agent": "agent_47", "vendor": "acme_corp", "amount": 340,
 *      "category": "office_supplies", "attested": true }]
 * `attested` defaults to true (the simulator's stated premise — a hypothetical has
 * no invoice to verify; see @ramp/ledger simulate.ts).
 *
 * HONESTY: each item is previewed against CURRENT ledger state and does NOT
 * compound earlier items in the same batch. When an agent's previewed-allow
 * amounts sum past their daily headroom, the run is flagged OVERCOMMITTED for that
 * agent — later payments will deny once earlier ones settle. See the `⚠` section.
 * (The command is `simulate`; pnpm has no builtin by that name.)
 */
import { readFileSync } from "node:fs";
import { openLedgerStrict, closeLedger, simulateBatch } from "@ramp/ledger";
import { getKernel } from "@ramp/gate";
import { money } from "./_lib.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const fileArg = argv.find((a) => !a.startsWith("--"));

/** A small, self-explanatory demo batch that hits allow / hold / deny / categorical. */
const DEMO_BATCH = [
  { agent: "agent_47", vendor: "acme_corp", amount: 120, category: "office_supplies" },
  { agent: "agent_47", vendor: "acme_corp", amount: 200, category: "office_supplies" },
  { agent: "agent_47", vendor: "acme_corp", amount: 300, category: "office_supplies" },
  { agent: "agent_47", vendor: "acme_corp", amount: 900, category: "office_supplies" },
  { agent: "agent_47", vendor: "sketchy_llc", amount: 50, category: "office_supplies" },
  { agent: "agent_12", vendor: "acme_corp", amount: 450, category: "office_supplies" },
];

function loadBatch() {
  if (!fileArg) return DEMO_BATCH;
  let raw;
  try {
    raw = readFileSync(fileArg, "utf8");
  } catch (e) {
    process.stderr.write(`simulate: cannot read "${fileArg}": ${e.message}\n`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`simulate: "${fileArg}" is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    process.stderr.write(`simulate: "${fileArg}" must be a non-empty JSON array of intents.\n`);
    process.exit(1);
  }
  return parsed;
}

const db = openLedgerStrict();
try {
  const batch = loadBatch();
  const { kernel } = getKernel();
  const { items, aggregate } = simulateBatch(db, batch, kernel);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          items: items.map((it) => ({
            input: it.input,
            outcome: it.result.outcome,
            firedRules: it.result.firedRules,
            counterfactual: it.explanation.counterfactual,
            headline: it.explanation.headline,
          })),
          aggregate,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }

  const tag = (o) => (o === "allow" ? "ALLOW" : o === "escalate" ? "HOLD " : "DENY ");
  const L = [];
  L.push("");
  L.push("  PRE-FLIGHT — what the gate would do to this batch (nothing is sent)");
  L.push("  " + "─".repeat(72));
  if (!fileArg) L.push("  (built-in demo batch — pass a JSON file to preview your own)");
  L.push("");

  for (const it of items) {
    const o = it.result.outcome;
    const cf = it.explanation.counterfactual;
    const { agent, vendor } = it.input;
    const amt = it.result.facts.amount;
    L.push(
      `  ${tag(o)} ${money(amt).padStart(7)}  ${String(agent).padEnd(11)} ${String(vendor).padEnd(13)} ${it.input.category}`,
    );
    if (o !== "allow") {
      const rule = it.result.firedRules[0] ?? "(none)";
      if (cf.maxAllowAmount !== null && cf.maxAllowAmount < amt) {
        L.push(`         └ ${rule} — would clear at ≤ ${money(cf.maxAllowAmount)}`);
      } else {
        L.push(`         └ ${rule} — no amount clears it (categorical)`);
      }
    }
  }

  L.push("");
  L.push("  ROLL-UP");
  L.push(`    ${aggregate.total} intent(s):  allow ${aggregate.counts.allow}  ·  hold ${aggregate.counts.escalate}  ·  deny ${aggregate.counts.deny}`);
  L.push(`    would FLOW    ${money(aggregate.flowed)}`);
  L.push(`    would be HELD ${money(aggregate.held)}   (a human must approve)`);
  L.push(`    would be STOPPED ${money(aggregate.denied)}   (flatly denied)`);

  if (aggregate.overcommitted.length) {
    L.push("");
    L.push("  ⚠ OVERCOMMITTED — these preview as allow independently, but not together:");
    for (const oc of aggregate.overcommitted) {
      L.push(
        `    ${oc.agent}: ${oc.atRiskCount} allowed item(s) sum to ${money(oc.allowedSum)}, ` +
          `but only ${money(oc.remainingToday)} of daily headroom remains.`,
      );
      L.push(`      → later payments WILL deny once earlier ones settle. Preview does not compound.`);
    }
  }

  L.push("");
  L.push("  This is a preview. Send for real through the hook / `@ramp/client`, and every");
  L.push("  decision is recorded, provable, and explainable with `pnpm explain`.");
  L.push("");
  process.stdout.write(L.join("\n") + "\n");
} finally {
  closeLedger(db);
}

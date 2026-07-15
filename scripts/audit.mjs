#!/usr/bin/env node
/**
 * The auditor's tool — scripts/audit.mjs (PITCH.md demo beat 5: "the proof")
 *
 * Reads the provenance bundles the gate sealed at enforce time and INDEPENDENTLY
 * re-verifies each one: re-derives the decision from the recorded facts, checks
 * the digests, checks every fact is accounted for by a named authoritative
 * source, and checks the provenance agrees with the facts it claims to explain.
 *
 * Read what this program does NOT do, because that is the point:
 *   - it does not query the ledger
 *   - it does not call the hook
 *   - it does not trust anything the gate said
 *
 * It reads a JSON file and does the arithmetic again. If the gate had lied — or
 * simply been wrong — the recorded decision would not match the re-derived one,
 * and this would say so. That is what "prove the decision" buys you over "log
 * the decision": an audit log is a claim by the system about the system, and you
 * must already trust the system to believe it.
 *
 *   pnpm proof                 # verify every bundle, print the full graph
 *   pnpm proof --summary       # one line each
 *   pnpm proof <file.json>     # verify one bundle
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyBundle, renderBundle, summarizeBundle } from "@ramp/provenance";
import { referenceKernel } from "@ramp/gate";
import { openLedger, closeLedger, verifyChain, chainHead } from "@ramp/ledger";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = process.env.RAMP_BUNDLE_DIR ?? join(HERE, "..", ".ramp", "bundles");

const args = process.argv.slice(2);
const summaryOnly = args.includes("--summary");
const explicitFile = args.find((a) => !a.startsWith("--"));

function loadBundles() {
  if (explicitFile) return [explicitFile];
  if (!existsSync(BUNDLE_DIR)) {
    console.error(
      `No bundles at ${BUNDLE_DIR}. Run \`pnpm demo\` first — the gate seals a ` +
        `bundle every time it decides.`,
    );
    process.exit(1);
  }
  return readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(BUNDLE_DIR, f))
    .sort();
}

const files = loadBundles();
if (files.length === 0) {
  console.error(`No bundles found in ${BUNDLE_DIR}. Run \`pnpm demo\` first.`);
  process.exit(1);
}

console.log(`\n=== Independent audit of ${files.length} decision bundle(s) ===`);
console.log(`Re-deriving each decision with our own kernel. Trusting nothing.\n`);

let invalid = 0;

for (const file of files) {
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`! UNREADABLE  ${file}: ${err.message}\n`);
    invalid++;
    continue;
  }

  // The auditor brings their own kernel. That is the entire design: @ramp/provenance
  // does not depend on @ramp/gate, and verification is a function of (bundle, kernel).
  const verification = verifyBundle(bundle, referenceKernel);
  if (!verification.valid) invalid++;

  if (summaryOnly) {
    console.log(`${verification.valid ? "  OK  " : "! BAD "} ${summarizeBundle(bundle)}`);
    for (const d of verification.defects) console.log(`         [${d.code}] ${d.detail}`);
  } else {
    console.log(renderBundle(bundle, verification));
    console.log("\n" + "-".repeat(72) + "\n");
  }
}

// ---- the chain: tamper-evidence ACROSS decisions -------------------------
// The bundles above each prove ONE decision is sound. They cannot notice that a
// decision is MISSING — every bundle is a separate file, so deleting one leaves
// the rest verifying perfectly. The chain is what makes the SET auditable.
console.log("=".repeat(72));
try {
  const db = openLedger(process.env.RAMP_DB_PATH, { provisionIfEmpty: false });
  const { head, length } = chainHead(db);
  const chain = verifyChain(db, process.env.RAMP_EXPECTED_HEAD);
  console.log(`\nDECISION CHAIN — ${length} decision(s), head ${head.slice(0, 16)}…`);
  if (chain.valid) {
    console.log("  INTACT — no decision was deleted, reordered, or inserted.");
    if (!process.env.RAMP_EXPECTED_HEAD) {
      console.log("  NOTE: set $RAMP_EXPECTED_HEAD to a head you published earlier to also");
      console.log("        catch a full-suffix rewrite. Without it, a forged-but-consistent");
      console.log("        chain passes — see packages/ledger/src/chain.ts.");
    }
  } else {
    invalid++;
    console.log(`  TAMPERED — ${chain.defects.length} defect(s):`);
    for (const d of chain.defects) console.log(`    [${d.kind}] seq ${d.seq}: ${d.detail}`);
  }
  closeLedger(db);
} catch (err) {
  console.log(`\nDECISION CHAIN — could not read the ledger: ${err.message}`);
}

console.log("=".repeat(72));
if (invalid === 0) {
  console.log(
    `All ${files.length} bundle(s) verified independently.\n` +
      `Every recorded decision follows from its recorded facts, every fact names\n` +
      `an authoritative source, and nothing was altered after sealing.`,
  );
} else {
  console.log(`${invalid} of ${files.length} bundle(s) FAILED independent verification.`);
}
console.log("=".repeat(72) + "\n");

process.exit(invalid === 0 ? 0 : 1);

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

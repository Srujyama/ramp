#!/usr/bin/env node
/**
 * The portable receipt — scripts/receipt.mjs   (invoked as `pnpm receipt`)
 *
 *   pnpm receipt                     # a receipt for the newest DENIED decision
 *   pnpm receipt <requestId>         # ...for a specific request id
 *   pnpm receipt <digestPrefix>      # ...for the bundle file <digestPrefix>.json
 *   pnpm receipt -- --out <path>     # write somewhere specific
 *
 * "Here — verify it yourself." This emits ONE self-contained `.mjs` file that a
 * judge, an auditor, or a customer can run with nothing but `node`:
 *
 *     node ramp-receipt-<id>.mjs
 *     → RESULT: VERIFIED ✓
 *
 * The receipt has NO dependencies and needs NO network, NO database, and nothing
 * from this repo. It re-derives the decision from its own recorded facts using the
 * same policy, checks every digest, verifies the gate's Ed25519 signature against
 * the embedded PUBLIC key, and confirms nothing was altered after sealing.
 *
 * HOW IT STAYS HONEST: the verifier body is the repo's real `verify-ramp-proof.mjs`
 * inlined VERBATIM — the same file whose parity against the production kernel is
 * cross-checked in CI on thousands of randomized fact sets. We do not hand-copy the
 * rules into the receipt; we embed the audited verifier. Only a PUBLIC key is
 * embedded (safe to share; it verifies signatures, it cannot make them).
 *
 * The inlined verifier's own CLI does not fire inside the receipt: it guards on the
 * filename ending in `verify-ramp-proof.mjs`, and a receipt is named otherwise.
 * (Named `receipt`; pnpm has no builtin by that name.)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { createPublicKey } from "node:crypto";
import { demoGatePublicKey, DEMO_GATE_KEY_ID } from "@ramp/provenance";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VERIFIER_PATH = join(ROOT, "verify-ramp-proof.mjs");
const BUNDLE_DIR = process.env.RAMP_BUNDLE_DIR ?? join(ROOT, ".ramp", "bundles");
const RECEIPT_DIR = join(ROOT, ".ramp", "receipts");

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
const selector = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");

function fail(msg) {
  process.stderr.write(`receipt: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(BUNDLE_DIR)) {
  fail(`no bundles at ${BUNDLE_DIR}. Run \`pnpm demo\` first — the gate seals a bundle per decision.`);
}
if (!existsSync(VERIFIER_PATH)) {
  fail(`the standalone verifier is missing at ${VERIFIER_PATH}.`);
}

/** Load + parse a bundle file, or null on any error. */
function loadBundle(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Pick the target bundle path from the selector (or default to a deny). */
function pickBundle() {
  const files = readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".json"));
  // 1. selector is a bundle filename / digest prefix.
  if (selector) {
    const byName = files.find((f) => f === `${selector}.json` || f.startsWith(selector));
    if (byName) return join(BUNDLE_DIR, byName);
    // 2. selector is a requestId — match bundle.requestId.
    const matches = files
      .map((f) => join(BUNDLE_DIR, f))
      .map((p) => ({ p, b: loadBundle(p) }))
      .filter((x) => x.b && x.b.requestId === selector);
    if (matches.length) return matches[matches.length - 1].p;
    fail(`no bundle matches "${selector}" (tried filename prefix and requestId). See \`pnpm proof\`.`);
  }
  // 3. default: the newest DENY bundle (the most compelling receipt), else any.
  const all = files.map((f) => join(BUNDLE_DIR, f)).map((p) => ({ p, b: loadBundle(p) })).filter((x) => x.b);
  const deny = all.filter((x) => x.b.decision?.decision === "deny");
  const pool = deny.length ? deny : all;
  if (!pool.length) fail("no readable bundles to export.");
  return pool[pool.length - 1].p;
}

const bundlePath = pickBundle();
const bundle = loadBundle(bundlePath);
if (!bundle) fail(`could not parse bundle ${bundlePath}.`);

// The gate PUBLIC key, in PEM — derived now so the receipt always carries the
// current demo gate key. A public key only VERIFIES signatures; embedding it is safe.
// demoGatePublicKey() may hand back a KeyObject or a PEM string; normalise to PEM.
const gateKeyRaw = demoGatePublicKey();
const gateKeyObj =
  typeof gateKeyRaw === "string" ? createPublicKey(gateKeyRaw) : gateKeyRaw;
const gatePem = gateKeyObj.export({ type: "spki", format: "pem" }).toString();

const verifierSrc = readFileSync(VERIFIER_PATH, "utf8");
const reqId = String(bundle.requestId ?? "decision");
const safeId = reqId.replace(/[^A-Za-z0-9_.-]/g, "_");

// ---- assemble the self-contained receipt ----------------------------------
// The verifier source is embedded verbatim (its CLI won't fire — filename guard).
// Then the bundle, the gate public key, and a driver that runs verifyBundle.
const driver = `
// ============================================================================
// EMBEDDED DECISION RECEIPT — generated by \`pnpm receipt\`. Everything below is
// data + a driver; everything above is the repo's real verify-ramp-proof.mjs,
// inlined verbatim (its own CLI is inert here because this file is named
// differently). Run:  node __RECEIPT_BASENAME__
// ============================================================================
const BUNDLE = ${JSON.stringify(bundle, null, 2)};

const GATE_PUBLIC_KEY_PEM = ${JSON.stringify(gatePem)};
const GATE_KEY_ID = ${JSON.stringify(DEMO_GATE_KEY_ID)};

{
  const out = process.stdout;
  out.write("\\n=== RAMP decision receipt — verify it yourself, offline, zero deps ===\\n\\n");
  out.write("  request:  " + (BUNDLE.requestId ?? "(none)") + "\\n");
  out.write("  decision: " + (BUNDLE.decision?.decision ?? "(none)").toUpperCase() + "\\n");
  const reasons = BUNDLE.decision?.reasons ?? [];
  if (reasons[0]) out.write("  reason:   " + reasons[0] + "\\n");
  out.write("  gate key: " + GATE_KEY_ID + "\\n\\n");
  out.write("  Re-deriving the decision from its recorded facts, checking every digest,\\n");
  out.write("  and verifying the gate's signature against the embedded PUBLIC key...\\n\\n");

  const v = verifyBundle(BUNDLE, { gatePublicKeyPem: GATE_PUBLIC_KEY_PEM });

  if (v.valid) {
    out.write("  RESULT: VERIFIED \\u2713\\n\\n");
    out.write("  The recorded decision was RE-DERIVED from its own recorded facts and\\n");
    out.write("  matched; every digest checks out; the gate signature is authentic; and\\n");
    out.write("  nothing was altered after sealing. You did not trust the gate.\\n\\n");
    out.write("  (A pass does NOT prove the facts were true, nor that no OTHER decision is\\n");
    out.write("   missing — this receipt is one decision. See the header of the verifier above.)\\n\\n");
    process.exit(0);
  } else {
    out.write("  RESULT: NOT VERIFIED \\u2717\\n\\n");
    for (const d of v.defects) out.write("    [" + d.code + "] " + d.detail + "\\n");
    out.write("\\n");
    process.exit(1);
  }
}
`;

const receipt = `${verifierSrc}\n${driver}`;

const target = outPath ?? join(RECEIPT_DIR, `ramp-receipt-${safeId}.mjs`);
// Always ensure the destination directory exists — a caller-supplied `--out` may
// point into a directory that does not exist yet (e.g. a fresh CI checkout has no
// .ramp/receipts/), and writeFileSync would otherwise throw ENOENT.
const targetDir = dirname(target);
if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
// Replace the basename placeholder in the banner now that we know the path.
writeFileSync(target, receipt.replace("__RECEIPT_BASENAME__", basename(target)), "utf8");

process.stdout.write(
  `\n  Wrote a self-contained proof receipt:\n    ${target}\n\n` +
    `  It has zero dependencies and needs nothing from this repo. Hand it to anyone;\n` +
    `  they verify the decision themselves with just Node:\n\n` +
    `    node ${target}\n\n`,
);

#!/usr/bin/env node
/**
 * NON-PAYMENT DEMO — the gate is an authorization primitive, not a spend feature
 * ============================================================================
 * Drives scripts/deploy-gate.mjs (spawned as a real subprocess, exactly how a
 * host would call it) through a production-deploy scenario, asserting the exit
 * code and fired rule for every beat — then RE-EXECUTES a sealed bundle to prove
 * the decision is reproducible, and tampers one to prove tampering is caught.
 *
 * Same kernel shape, same @ramp/provenance proof engine, zero money. If this is
 * green, "swap the fact source and the same gate governs any irreversible agent
 * action" is shown, not asserted.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@ramp/shared";
import { digest } from "@ramp/provenance";
import { deployKernel } from "./deploy/policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "deploy-gate.mjs");
const BUNDLE_DIR = join(HERE, "..", ".ramp", "deploy-bundles");

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", DIM = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

function runGate(toolInput) {
  const res = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, RAMP_DEPLOY_BUNDLE_DIR: BUNDLE_DIR },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { exit: res.status, ...(parsed ?? {}) };
}

// A valid production deploy: in-window, CI green, 2 approvals, small blast radius.
const okDeploy = {
  requestId: "deploy_checkout_001",
  requestingAgent: "agent_release",
  service: "checkout-api",
  environment: "production",
  context: { changeWindowOpen: true, ciGreen: true, approvalsCount: 2, blastRadius: 10 },
};
const withCtx = (over) => ({ ...okDeploy, context: { ...okDeploy.context, ...over } });

const beats = [
  { name: "In-window, CI green, 2/2 approvals, small blast radius", input: okDeploy, want: "allow", exit: 0, rule: "all_conditions_met" },
  { name: "Change window is CLOSED", input: withCtx({ changeWindowOpen: false }), want: "deny", exit: 2, rule: "outside_change_window" },
  { name: "CI is RED", input: withCtx({ ciGreen: false }), want: "deny", exit: 2, rule: "ci_not_green" },
  { name: "Only 1 of 2 required approvals", input: withCtx({ approvalsCount: 1 }), want: "deny", exit: 2, rule: "insufficient_approvals" },
  { name: "Blast radius over the cap (80 > 50)", input: withCtx({ blastRadius: 80 }), want: "deny", exit: 2, rule: "blast_radius_too_large" },
  { name: "Large blast radius (35) → HELD for a human", input: withCtx({ blastRadius: 35 }), want: "ask", exit: 0, rule: "high_blast_radius" },
  { name: "CI red AND over threshold → deny DOMINATES escalate", input: withCtx({ ciGreen: false, blastRadius: 35 }), want: "deny", exit: 2, rule: "ci_not_green" },
  { name: "Malformed fact: non-integer blast radius", input: withCtx({ blastRadius: 1.5 }), want: "deny", exit: 2, rule: "malformed_facts" },
];

let failures = 0;
console.log(`\n${B}Warrant — production-deploy gate (no money)${X}\n`);
let lastDenyDigest = null;

for (const beat of beats) {
  const r = runGate(beat.input);
  const gotDecision = r.permissionDecision ?? (r.exit === 2 ? "deny" : "(none)");
  const rules = r.firedRules ?? [];
  const ok = gotDecision === beat.want && r.exit === beat.exit && rules.includes(beat.rule);
  const color = beat.want === "allow" ? G : beat.want === "ask" ? Y : R;
  console.log(
    `  ${ok ? G + "✔" + X : R + "✗" + X} ${beat.name}\n` +
      `      ${DIM}→${X} ${color}${gotDecision.toUpperCase()}${X} exit ${r.exit}  ${DIM}${rules.join(", ") || "-"}${X}`,
  );
  if (!ok) {
    failures++;
    console.log(`      ${R}expected ${beat.want}/exit ${beat.exit}/${beat.rule}${X}`);
  }
  if (beat.want === "deny" && r.bundleDigest && !lastDenyDigest) lastDenyDigest = r.bundleDigest;
}

// ---- The re-executable proof: re-run the kernel on a sealed bundle -----------
console.log(`\n${B}Re-executable proof — an outsider re-derives the decision${X}\n`);

/** Soundness + integrity re-check, using the SAME digest engine the gate sealed with. */
function verifyDeployBundle(bundle) {
  const factsOk = digest(bundle.facts) === bundle.factsDigest;
  const rederived = deployKernel.evaluate(bundle.facts);
  const soundOk = canonicalJson(rederived) === canonicalJson(bundle.decision);
  return { valid: factsOk && soundOk, factsOk, soundOk, rederived };
}

if (!lastDenyDigest) {
  console.log(`  ${R}✗ no sealed deny bundle was produced${X}`);
  failures++;
} else {
  const path = join(BUNDLE_DIR, `${lastDenyDigest.slice(0, 16)}.json`);
  const bundle = JSON.parse(readFileSync(path, "utf8"));

  const v = verifyDeployBundle(bundle);
  const okHonest = v.valid === true;
  console.log(
    `  ${okHonest ? G + "✔" + X : R + "✗" + X} honest bundle re-derives to the SAME decision ` +
      `${DIM}(${bundle.decision.decision}/${bundle.decision.firedRules.join(",")})${X}`,
  );
  if (!okHonest) failures++;

  // Tamper: flip the recorded decision. Re-derivation must catch it.
  const tampered = { ...bundle, decision: { ...bundle.decision, decision: "allow", firedRules: ["all_conditions_met"] } };
  const vt = verifyDeployBundle(tampered);
  const okTamper = vt.valid === false && vt.soundOk === false;
  console.log(
    `  ${okTamper ? G + "✔" + X : R + "✗" + X} a decision flipped deny→allow is REJECTED ` +
      `${DIM}(re-run says ${vt.rederived.decision}, not allow)${X}`,
  );
  if (!okTamper) failures++;
}

console.log();
if (failures === 0) {
  console.log(`${G}${B}✔ deploy gate: ${beats.length} beats + re-executable proof — all green.${X}`);
  console.log(`${DIM}  Same kernel shape, same @ramp/provenance proof engine, no money. The gate is a primitive.${X}\n`);
  process.exit(0);
} else {
  console.log(`${R}${B}✗ ${failures} check(s) failed.${X}\n`);
  process.exit(1);
}

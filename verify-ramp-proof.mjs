#!/usr/bin/env node
// ============================================================================
// verify-ramp-proof.mjs — the AUDITOR'S verifier
// ============================================================================
// Copy this ONE FILE anywhere and run it. Zero dependencies, zero installs, no
// network, no database, nothing from the ramp monorepo:
//
//     node verify-ramp-proof.mjs decision-bundle.json
//     node verify-ramp-proof.mjs .ramp/bundles/           # a whole directory
//     node verify-ramp-proof.mjs bundle.json --json       # machine-readable
//
// Exit 0 = every bundle verified. Exit 1 = at least one did not. Exit 2 = usage.
//
// ============================================================================
// WHY THIS FILE EXISTS AT ALL
// ============================================================================
// `pnpm proof` already verifies bundles — but it does so by importing our code,
// from our repo, in our workspace. If you are auditing us, that is worth exactly
// nothing: you would be asking the thing under audit whether it is honest.
//
// So the claim this file makes is narrow and, I think, actually defensible:
//
//     You do not have to trust our monorepo. You have to trust ~300 lines you
//     can read in ten minutes, and `node`.
//
// That is not "trustless" — you are still trusting this file and your Node
// install. It is *auditable*, which is the achievable thing. Read it. It is
// short on purpose, and it has no dependencies on purpose: a dependency is a
// thing you would also have to audit.
//
// ============================================================================
// THE HONEST PROBLEM WITH THIS FILE: IT IS A SECOND KERNEL
// ============================================================================
// To check "does this decision follow from these facts?" the verifier must know
// the policy. So the rules are re-implemented below — which means there are now
// TWO implementations of the policy (the real kernel, and this), and two
// implementations can DISAGREE. A verifier that disagrees with the gate is worse
// than no verifier: it manufactures false alarms, or worse, false confidence.
//
// We do not solve that by being careful. We solve it the same way the repo
// already handles its WASM kernel: a PARITY TEST cross-checks this file against
// the real reference kernel — on the golden cases AND on thousands of randomized
// fact sets — and CI fails if they ever diverge by so much as a reason string.
// See packages/gate/test/standalone-parity.test.ts.
//
// So: this file is a second kernel, and the drift risk is real, and it is
// mechanically checked rather than promised. If you are auditing, that test is
// the thing to look at next.
//
// ============================================================================
// WHAT A PASS MEANS, AND WHAT IT DOES NOT
// ============================================================================
// A PASS means, for each bundle:
//   1. INTEGRITY  — the facts and the bundle hash to what they claim. Nothing
//                   was edited after sealing.
//   2. SOUNDNESS  — re-running the policy on the recorded facts reproduces the
//                   recorded decision. The decision FOLLOWS from the facts.
//   3. COMPLETENESS — every fact names an authoritative source. No fact appeared
//                   from nowhere.
//   4. HONESTY    — the provenance agrees with the facts it claims to explain.
//
// A pass does NOT mean:
//   - that the FACTS were true. If the ledger lied, this verifies a faithful
//     derivation from a lie. Nothing downstream can fix that; it is why
//     `vendor_verified` is backed by cryptography rather than a database
//     boolean. This file checks the chain of reasoning, not its roots.
//   - that no decision is MISSING. Each bundle is a separate file; deleting one
//     leaves the rest verifying perfectly. That is what the ledger's hash chain
//     is for (`pnpm proof`, which reads the DB). If you only have bundles, you
//     cannot know what you were not given.
//   - that the gate was RUNNING correctly at the time. It means the record it
//     produced is internally sound.
// ----------------------------------------------------------------------------

import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_VERSION = 1;

// ---------------------------------------------------------------------------
// 1. Canonical encoding. Must match @ramp/shared's canonicalJson byte for byte,
//    or every honest bundle looks tampered with.
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively; array order preserved. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}"
  );
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const digest = (v) => sha256(canonicalJson(v));

// ---------------------------------------------------------------------------
// 2. The policy. A mirror of packages/gate/src/reference-kernel.ts and
//    packages/gate/datalog/policy.dl. Kept in lockstep by a parity test.
//
//    Deny dominates. The evaluation ORDER is part of the contract: it fixes the
//    order of `reasons`/`firedRules`, which the comparison below is byte-exact
//    about. Order never affects allow/deny.
// ---------------------------------------------------------------------------

const NUMERIC_FACTS = ["amount", "daily_total_so_far", "per_txn_cap", "daily_limit"];

/** Numeric fields that are not finite, non-negative integers. */
function malformedNumerics(f) {
  return NUMERIC_FACTS.filter((k) => {
    const v = f[k];
    return typeof v !== "number" || !Number.isInteger(v) || v < 0;
  });
}

/**
 * Evaluate the policy. Pure: no clock, no I/O, no randomness — which is exactly
 * what makes a decision re-derivable, and therefore this file possible at all.
 */
function evaluate(f) {
  // D0: malformed facts. Returned ALONE — we do not reason about garbage.
  // (NaN is poison: every comparison against it is false, so D2 and D5 would
  // both silently fail to fire and a NaN amount would be payable.)
  const malformed = malformedNumerics(f);
  if (malformed.length > 0) {
    return {
      decision: "deny",
      reasons: [
        `malformed_facts: ${malformed.join(", ")} must be finite, non-negative ` +
          `integers (money is whole units); refusing to evaluate`,
      ],
      firedRules: ["deny/malformed_facts"],
    };
  }

  const denies = [];
  const cleared = f.agent_cleared_categories.includes(f.category);
  const approved = f.approved_categories.includes(f.category);

  // D1
  if (!f.vendor_verified) {
    denies.push([
      "deny/vendor_not_verified",
      `vendor_not_verified: vendor "${f.vendor}" is not verified in the registry`,
    ]);
  }
  // D2
  if (f.amount > f.per_txn_cap) {
    denies.push([
      "deny/over_per_txn_cap",
      `over_per_txn_cap: amount ${f.amount} > per_txn_cap ${f.per_txn_cap}`,
    ]);
  }
  // D4
  if (!approved) {
    denies.push([
      "deny/category_not_approved",
      `category_not_approved: category "${f.category}" is not on the org's approved list`,
    ]);
  }
  // D3
  if (!cleared) {
    denies.push([
      "deny/agent_uncleared_for_category",
      `agent_uncleared_for_category: agent "${f.requesting_agent}" is not cleared for category "${f.category}"`,
    ]);
  }
  // D5
  if (f.daily_total_so_far + f.amount > f.daily_limit) {
    denies.push([
      "deny/daily_limit_exceeded",
      `daily_limit_exceeded: ${f.daily_total_so_far} + ${f.amount} > daily_limit ${f.daily_limit}`,
    ]);
  }
  // D6
  if (!f.attestation_present) {
    denies.push([
      "deny/attestation_invalid",
      `attestation_invalid: no verified attestation binds this invoice to vendor ` +
        `"${f.vendor}" — refusing to pay on an unattested document`,
    ]);
  }
  // D8: the agent did not prove its identity (signature vs its REGISTERED key,
  // verified out of band; only the verdict is a fact). Missing signature, wrong
  // key, unregistered and revoked all collapse to false — and false denies.
  if (!f.agent_identity_verified) {
    denies.push([
      "deny/unauthenticated_agent",
      `unauthenticated_agent: agent "${f.requesting_agent}" did not prove its ` +
        `identity — no signature verified against its registered key`,
    ]);
  }

  // D7: any additional budget this spend would break. Generic over scope; the
  // list is pre-sorted by (scope, key) so reasons are byte-stable.
  for (const b of f.budgets ?? []) {
    if (b.spent + f.amount > b.limit) {
      denies.push([
        "deny/budget_exceeded",
        `budget_exceeded: ${b.scope} budget for "${b.key}" — ` +
          `${b.spent} + ${f.amount} > ${b.limit}`,
      ]);
    }
  }

  // ESCALATE (E1, E2) — a third outcome: the rulebook cannot settle this, a
  // human must. The payment is HELD; it is not "allowed pending review".
  const escalations = [];
  if (f.amount > f.escalation_threshold) {
    escalations.push([
      "escalate/over_escalation_threshold",
      `over_escalation_threshold: amount ${f.amount} > escalation_threshold ` +
        `${f.escalation_threshold} (within the ${f.per_txn_cap} cap, but a human must approve)`,
    ]);
  }
  if (f.vendor_risk_tier === "elevated") {
    escalations.push([
      "escalate/elevated_risk_vendor",
      `elevated_risk_vendor: vendor "${f.vendor}" is verified but carries risk tier ` +
        `"${f.vendor_risk_tier}" — a human must approve`,
    ]);
  }
  if (f.recent_txn_count >= f.velocity_limit) {
    escalations.push([
      "escalate/velocity_exceeded",
      `velocity_exceeded: agent "${f.requesting_agent}" has settled ${f.recent_txn_count} ` +
        `payment(s) in the velocity window (limit ${f.velocity_limit}) — a human must approve the next`,
    ]);
  }
  if (f.duplicate_recent_count >= 1) {
    escalations.push([
      "escalate/possible_duplicate",
      `possible_duplicate: ${f.duplicate_recent_count} settled payment(s) already match vendor ` +
        `"${f.vendor}", amount ${f.amount}, category "${f.category}" in the dedup window — ` +
        `a human must confirm this is not a repeat`,
    ]);
  }

  // deny > escalate > allow. Deny first: an escalation must never hand a human a
  // request that policy already rejected.
  if (denies.length > 0) {
    return {
      decision: "deny",
      reasons: denies.map(([, r]) => r),
      firedRules: denies.map(([id]) => id),
    };
  }
  if (escalations.length > 0) {
    return {
      decision: "escalate",
      reasons: escalations.map(([, r]) => r),
      firedRules: escalations.map(([id]) => id),
    };
  }
  return {
    decision: "allow",
    reasons: [
      `all_conditions_met: amount ${f.amount} within cap ${f.per_txn_cap}, ` +
        `category "${f.category}" approved and agent "${f.requesting_agent}" cleared, ` +
        `vendor "${f.vendor}" verified, ` +
        `daily ${f.daily_total_so_far} + ${f.amount} <= ${f.daily_limit}, ` +
        `attestation verified, agent identity verified`,
    ],
    firedRules: ["allow/all_conditions_met"],
  };
}

// The complete fact set + the source each one must come from. Mirrors
// @ramp/shared's FACT_SOURCES. Completeness is checked against THIS list, so a
// fact that appears from nowhere has nowhere to hide.
const FACT_SOURCES = {
  request_id: "tool_args",
  requesting_agent: "tool_args",
  amount: "tool_args",
  vendor: "tool_args",
  category: "tool_args",
  vendor_verified: "vendor_registry",
  daily_total_so_far: "ledger_db",
  per_txn_cap: "policy_config",
  daily_limit: "policy_config",
  approved_categories: "policy_config",
  agent_cleared_categories: "policy_config",
  attestation_present: "attestation",
  agent_identity_verified: "identity",
  escalation_threshold: "policy_config",
  vendor_risk_tier: "vendor_registry",
  budgets: "ledger_db",
  recent_txn_count: "ledger_db",
  velocity_limit: "policy_config",
  duplicate_recent_count: "ledger_db",
};

// ---------------------------------------------------------------------------
// 3. Verify one bundle.
// ---------------------------------------------------------------------------

/** @returns {{valid: boolean, defects: {code: string, detail: string}[], rederived: object|null}} */
export function verifyBundle(bundle, opts = {}) {
  const defects = [];
  const bad = (code, detail) => defects.push({ code, detail });

  if (typeof bundle !== "object" || bundle === null) {
    return { valid: false, defects: [{ code: "malformed", detail: "not an object" }], rederived: null };
  }
  if (bundle.bundleVersion !== BUNDLE_VERSION) {
    return {
      valid: false,
      defects: [{ code: "version_mismatch", detail: `version ${bundle.bundleVersion} != ${BUNDLE_VERSION}` }],
      rederived: null,
    };
  }
  for (const k of ["facts", "decision", "provenance", "factsDigest", "bundleDigest"]) {
    if (bundle[k] === undefined) {
      return { valid: false, defects: [{ code: "malformed", detail: `missing ${k}` }], rederived: null };
    }
  }

  // ---- 1. INTEGRITY -------------------------------------------------------
  const factsDigest = digest(bundle.facts);
  if (factsDigest !== bundle.factsDigest) {
    bad("facts_digest_mismatch", `facts were altered after sealing (recomputed ${factsDigest.slice(0, 16)}…)`);
  }
  const { bundleDigest, gateSignature: _sig, ...unsealed } = bundle;
  const recomputed = digest(unsealed);
  if (recomputed !== bundleDigest) {
    bad("bundle_digest_mismatch", `the bundle was altered after sealing (recomputed ${recomputed.slice(0, 16)}…)`);
  }

  // ---- 2. SOUNDNESS — the one that matters --------------------------------
  // We do not read the recorded decision and believe it. We recompute it.
  // A forger who understands digests can re-seal; they cannot re-seal their way
  // out of arithmetic.
  let rederived = null;
  try {
    rederived = evaluate(bundle.facts);
    if (canonicalJson(rederived) !== canonicalJson(bundle.decision)) {
      bad(
        "decision_mismatch",
        `the recorded decision does NOT follow from the recorded facts. ` +
          `recorded=${bundle.decision?.decision} rederived=${rederived.decision}`,
      );
    }
  } catch (err) {
    bad("decision_mismatch", `could not re-derive: ${err.message}`);
  }

  // ---- 3. COMPLETENESS + 4. HONESTY --------------------------------------
  const byFact = new Map();
  for (const p of bundle.provenance ?? []) {
    if (byFact.has(p.fact)) bad("provenance_duplicate", `fact "${p.fact}" explained twice`);
    byFact.set(p.fact, p);
  }
  for (const key of Object.keys(FACT_SOURCES)) {
    if (!byFact.has(key)) {
      // An unexplained fact is a hole exactly the shape of an injected one.
      bad("provenance_incomplete", `fact "${key}" has no provenance — its origin is unaccounted for`);
    }
  }
  for (const [key, p] of byFact) {
    if (!(key in FACT_SOURCES)) {
      bad("provenance_incomplete", `provenance names "${key}", which is not a fact`);
      continue;
    }
    if (canonicalJson(bundle.facts[key]) !== canonicalJson(p.value)) {
      bad("provenance_value_mismatch", `provenance for "${key}" disagrees with the facts`);
    }
    if (p.source !== FACT_SOURCES[key]) {
      bad("provenance_value_mismatch", `"${key}" claims source "${p.source}", contract says "${FACT_SOURCES[key]}"`);
    }
  }

  // ---- 5. GATE SIGNATURE (optional) --------------------------------------
  // Only meaningful if you supplied a key OUT OF BAND. A key read from the
  // bundle itself would prove nothing — the forger would simply include theirs.
  if (opts.gatePublicKeyPem) {
    if (!bundle.gateSignature) {
      bad("signature_missing", "a gate key was supplied but this bundle is unsigned");
    } else {
      let ok = false;
      try {
        ok = cryptoVerify(
          null,
          Buffer.from(`ramp.bundle.v1\n${bundleDigest}`, "utf8"),
          createPublicKey(opts.gatePublicKeyPem),
          Buffer.from(bundle.gateSignature.signature, "base64"),
        );
      } catch {
        ok = false;
      }
      if (!ok) bad("signature_invalid", "the gate signature does not verify over this bundle");
    }
  }

  return { valid: defects.length === 0, defects, rederived };
}

// ---------------------------------------------------------------------------
// 4. CLI
// ---------------------------------------------------------------------------

function collect(target) {
  const st = statSync(target);
  if (st.isDirectory()) {
    return readdirSync(target)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(target, f));
  }
  return [target];
}

/**
 * Split argv into positional targets and flags.
 *
 * The subtlety that bit: `--gate-key <path>` takes a VALUE, so a naive
 * `argv.filter(a => !a.startsWith("--"))` keeps the path and then tries to
 * verify the PUBLIC KEY as if it were a bundle — reporting a confident,
 * meaningless failure on a file that was never a bundle. Flags with values must
 * consume their value.
 */
function parseArgs(argv) {
  const targets = [];
  let asJson = false;
  let gateKeyPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--gate-key") gateKeyPath = argv[++i]; // consume the value
    else if (a.startsWith("--")) {
      process.stderr.write(`unknown flag: ${a}\n`);
      return null;
    } else targets.push(a);
  }
  return { targets, asJson, gateKeyPath };
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed === null) return 2;
  const { targets: args, asJson, gateKeyPath } = parsed;

  let gatePublicKeyPem;
  if (gateKeyPath !== undefined) {
    try {
      gatePublicKeyPem = readFileSync(gateKeyPath, "utf8");
    } catch (err) {
      process.stderr.write(`--gate-key: cannot read ${gateKeyPath}: ${err.message}\n`);
      return 2;
    }
  }

  if (args.length === 0) {
    process.stderr.write(
      "usage: node verify-ramp-proof.mjs <bundle.json | dir> [--gate-key pub.pem] [--json]\n" +
        "\n" +
        "Verifies ramp decision bundles with no dependencies and no network.\n" +
        "Exit 0 = all verified, 1 = at least one failed.\n",
    );
    return 2;
  }

  const files = args.flatMap(collect);
  if (files.length === 0) {
    process.stderr.write("no .json bundles found\n");
    return 2;
  }

  const results = [];
  for (const file of files) {
    let bundle;
    try {
      bundle = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      results.push({ file, valid: false, defects: [{ code: "unreadable", detail: err.message }] });
      continue;
    }
    const v = verifyBundle(bundle, { gatePublicKeyPem });
    results.push({
      file,
      requestId: bundle.requestId,
      recorded: bundle.decision?.decision,
      rederived: v.rederived?.decision ?? null,
      valid: v.valid,
      defects: v.defects,
    });
  }

  const failed = results.filter((r) => !r.valid);

  if (asJson) {
    process.stdout.write(JSON.stringify({ results, valid: failed.length === 0 }, null, 2) + "\n");
    return failed.length === 0 ? 0 : 1;
  }

  process.stdout.write(`\nverify-ramp-proof — ${files.length} bundle(s), no deps, nothing trusted\n\n`);
  for (const r of results) {
    const mark = r.valid ? "  OK  " : "! BAD ";
    process.stdout.write(
      `${mark} ${String(r.requestId ?? r.file).padEnd(34)} recorded=${String(r.recorded).padEnd(5)} re-derived=${String(r.rederived)}\n`,
    );
    for (const d of r.defects) process.stdout.write(`         [${d.code}] ${d.detail}\n`);
  }
  process.stdout.write("\n" + "-".repeat(72) + "\n");
  if (failed.length === 0) {
    process.stdout.write(
      `All ${files.length} bundle(s) verified. Every recorded decision was re-derived\n` +
        `from its own recorded facts and matched. You did not trust the gate.\n\n` +
        `This does NOT prove the facts were true, and does NOT prove no decision is\n` +
        `missing — each bundle is a separate file. See the header.\n`,
    );
  } else {
    process.stdout.write(`${failed.length} of ${files.length} bundle(s) FAILED verification.\n`);
  }
  process.stdout.write("-".repeat(72) + "\n\n");
  return failed.length === 0 ? 0 : 1;
}

// Run only when invoked directly, so the parity test can import `evaluate`.
if (process.argv[1] && process.argv[1].endsWith("verify-ramp-proof.mjs")) {
  process.exit(main(process.argv.slice(2)));
}

export { evaluate, canonicalJson, digest };

/**
 * @ramp/gate — parity: the STANDALONE auditor's verifier vs the reference kernel.
 *
 * `/verify-ramp-proof.mjs` is the file we hand an auditor: one file, zero deps,
 * "you don't have to trust our monorepo." To check that a decision follows from
 * its facts, it has to know the policy — so it re-implements the rules, and that
 * makes it a SECOND KERNEL.
 *
 * Two implementations can disagree, and a verifier that disagrees with the gate
 * is worse than no verifier: it either cries wolf on honest bundles, or blesses
 * ones the real kernel would have rejected. Either way the auditor's report is
 * worthless, and worse, confidently worthless.
 *
 * This file is why that's acceptable. It's the same answer the repo already uses
 * for the WASM kernel: don't be careful, be CHECKED. If the standalone verifier
 * ever drifts from the reference oracle — by an outcome, a rule id, or a single
 * character of a reason string — CI goes red.
 *
 * The randomized sweep matters more than the golden cases. Golden cases only
 * cover what we thought of; the drift that actually bites is the edge nobody
 * enumerated. 5000 random fact sets is cheap and it covers the corners.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "@ramp/shared";
import { referenceKernel } from "../src/reference-kernel.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * Locate the auditor's file by walking UP from this module until we find it.
 *
 * Not a hardcoded `../../../`: this test runs from `dist-test/test/`, which is a
 * different depth than its own source, so a fixed path is wrong in one of the
 * two places and silently rots. Walking up finds the exact bytes we ship to an
 * auditor from wherever the test happens to execute — and if the file is ever
 * moved or deleted, this throws with a message that says so, which is correct:
 * the auditor's instructions would be stale and that is worth failing over.
 */
function findStandaloneVerifier(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "verify-ramp-proof.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = resolvePath(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "verify-ramp-proof.mjs not found walking up from this test. It is the file we " +
      "hand auditors; if it moved, README/PITCH instructions are now wrong.",
  );
}

const STANDALONE_PATH = findStandaloneVerifier();
const standalone = (await import(pathToFileUrl(STANDALONE_PATH))) as {
  evaluate: (f: Facts) => unknown;
  canonicalJson: (v: unknown) => string;
};
const standaloneEvaluate = standalone.evaluate;
const standaloneCanonical = standalone.canonicalJson;

/** file path -> file:// URL, so the dynamic import works on every platform. */
function pathToFileUrl(p: string): string {
  return new URL(`file://${p}`).href;
}

function baseFacts(overrides: Partial<Facts> = {}): Facts {
  return {
    request_id: "req_9f",
    requesting_agent: "agent_47",
    amount: 340,
    vendor: "acme_corp",
    category: "office_supplies",
    vendor_verified: true,
    daily_total_so_far: 1140,
    per_txn_cap: 500,
    daily_limit: 1500,
    approved_categories: ["office_supplies", "software", "travel"],
    agent_cleared_categories: ["office_supplies", "software"],
    attestation_present: true,
    ...overrides,
  };
}

/** The golden cases: one per rule, plus the boundaries and the pile-up. */
const CASES: readonly Facts[] = [
  baseFacts(), // allow
  baseFacts({ amount: 501 }), // over cap
  baseFacts({ amount: 361 }), // daily over
  baseFacts({ vendor: "sketchy_llc", vendor_verified: false }), // unverified
  baseFacts({ category: "crypto" }), // unapproved + uncleared
  baseFacts({ category: "travel" }), // approved but uncleared
  baseFacts({ attestation_present: false }), // D6
  baseFacts({ amount: NaN }), // D0
  baseFacts({ amount: 0.5 }), // D0 float
  baseFacts({ amount: -1 }), // D0 negative
  baseFacts({ amount: 500, daily_total_so_far: 1000 }), // == cap boundary
  baseFacts({ daily_total_so_far: 1160 }), // == daily boundary
  baseFacts({ amount: 0 }), // zero
  // Every deny at once — pins the full frozen ordering across both kernels.
  baseFacts({
    vendor: "sketchy_llc",
    vendor_verified: false,
    amount: 999,
    category: "crypto",
    attestation_present: false,
  }),
];

test("PARITY: the standalone verifier matches the reference kernel on every golden case", () => {
  for (const facts of CASES) {
    const ref = referenceKernel.evaluate(facts);
    const alone = standaloneEvaluate(facts) as typeof ref;
    // Deep-equal, not just outcome: reasons and firedRules are compared BYTE for
    // byte because verifyBundle compares whole decisions. A reason string that
    // drifts by one character turns every honest bundle into a false alarm.
    assert.deepEqual(
      alone,
      ref,
      `standalone verifier drifted from the kernel on ${JSON.stringify(facts)}`,
    );
  }
});

/** Deterministic RNG — a parity failure must always replay. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const CATEGORIES = ["office_supplies", "software", "travel", "crypto", "weapons", ""];
const VENDORS = ["acme_corp", "sketchy_llc", "", "'; DROP TABLE vendors;--", "оffice"];

test("PARITY: the two agree across 5000 randomized fact sets", () => {
  const rng = makeRng(0x5eed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

  for (let i = 0; i < 5000; i++) {
    // Include the hostile numerics on purpose: NaN/Infinity/floats are exactly
    // where two hand-written implementations diverge, because they are exactly
    // where the language stops being obvious.
    const amount = pick([
      Math.floor(rng() * 3000),
      NaN,
      Infinity,
      -Infinity,
      rng() * 10,
      -1,
      0,
    ]);
    const facts: Facts = {
      request_id: `req_${i}`,
      requesting_agent: pick(["agent_47", "agent_12", "agent_ghost"]),
      amount: amount as number,
      vendor: pick(VENDORS),
      category: pick(CATEGORIES),
      vendor_verified: rng() > 0.5,
      daily_total_so_far: pick([Math.floor(rng() * 3000), NaN, -5]) as number,
      per_txn_cap: pick([Math.floor(rng() * 1000), NaN]) as number,
      daily_limit: pick([Math.floor(rng() * 3000), NaN]) as number,
      approved_categories: CATEGORIES.filter(() => rng() > 0.5),
      agent_cleared_categories: CATEGORIES.filter(() => rng() > 0.5),
      attestation_present: rng() > 0.5,
    };

    const ref = referenceKernel.evaluate(facts);
    const alone = standaloneEvaluate(facts) as typeof ref;
    assert.deepEqual(alone, ref, `drift at iteration ${i} on ${JSON.stringify(facts)}`);
  }
});

test("PARITY: the standalone canonical encoder matches @ramp/shared's", async () => {
  // The digests are only meaningful if both sides encode identically. A
  // key-order difference here would make every honest bundle look tampered with.
  const { canonicalJson } = await import("@ramp/shared");
  const samples: unknown[] = [
    baseFacts(),
    { b: 2, a: 1 },
    { nested: { z: 1, a: { y: 2, b: 3 } } },
    [3, 1, 2],
    { arr: [{ b: 1, a: 2 }] },
    null,
    "plain",
    42,
    true,
    { withUndefined: undefined, kept: 1 },
    { unicode: "— ✓ é" },
  ];
  for (const s of samples) {
    assert.equal(
      standaloneCanonical(s),
      canonicalJson(s),
      `canonical encoding drifted on ${JSON.stringify(s)}`,
    );
  }
});

test("PARITY: the standalone verifier's fact list matches the frozen contract", async () => {
  // Completeness is checked against the verifier's own copy of FACT_SOURCES. If
  // a fact is added to the contract and not here, the verifier would silently
  // stop noticing that the new fact is unexplained — a hole exactly the shape of
  // an injected fact.
  const { FACT_SOURCES } = await import("@ramp/shared");
  const src = readFileSync(STANDALONE_PATH, "utf8");
  for (const [fact, source] of Object.entries(FACT_SOURCES)) {
    assert.ok(
      new RegExp(`${fact}:\\s*"${source}"`).test(src),
      `verify-ramp-proof.mjs is missing "${fact}: ${source}" — add it, or the ` +
        `auditor's verifier stops checking that fact's provenance`,
    );
  }
});

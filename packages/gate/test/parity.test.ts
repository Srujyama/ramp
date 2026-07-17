/**
 * @ramp/gate — parity test: reference kernel vs wasm kernel.
 *
 * Cross-checks that the WASM-compiled Souffle kernel agrees with the TS reference
 * oracle on every case. It SKIPS cleanly when the wasm artifact (`wasm/pkg`) is
 * absent — so `pnpm -r test` stays green with no souffle/wasm-pack installed.
 *
 * Run explicitly with: `pnpm --filter @ramp/gate test:parity`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "@ramp/shared";
import { referenceKernel } from "../src/reference-kernel.js";
import { WasmKernel, isWasmKernelAvailable } from "../src/wasm-kernel.js";

/** Same base facts as the golden suite; parity is checked over field overrides. */
function baseFacts(overrides: Partial<Facts> = {}): Facts {
  const base: Facts = {
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
    // True since pillar 4: D6 denies without a verified attestation, so the
    // baseline (an ALLOW case) must carry one.
    attestation_present: true,
  escalation_threshold: 400,
  vendor_risk_tier: "standard",
  budgets: [],
  recent_txn_count: 0,
  velocity_limit: 6,
  duplicate_recent_count: 0,
  };
  return { ...base, ...overrides };
}

const CASES: readonly Facts[] = [
  baseFacts(), // allow
  baseFacts({ amount: 501 }), // over cap
  baseFacts({ amount: 361 }), // daily over
  baseFacts({ vendor: "sketchy_llc", vendor_verified: false }), // unverified
  baseFacts({ category: "crypto" }), // unapproved + uncleared
  baseFacts({ attestation_present: false }), // D6: unattested
  // Every deny at once — pins the full fixed ordering across both kernels.
  baseFacts({
    vendor: "sketchy_llc",
    vendor_verified: false,
    amount: 999,
    category: "crypto",
    attestation_present: false,
  }),
  baseFacts({ category: "travel" }), // approved but uncleared
  baseFacts({ amount: 500, daily_total_so_far: 1000 }), // cap boundary
  baseFacts({ daily_total_so_far: 1160 }), // daily boundary
  // ESCALATE cases — the third lattice tier. Without these, a WASM kernel that
  // mishandles `escalate` (e.g. throwing on the outcome) passes parity silently.
  baseFacts({ amount: 450, daily_total_so_far: 0 }), // E1: within cap, over the escalation threshold → escalate
  baseFacts({ vendor_risk_tier: "elevated" }), // E2: verified but elevated-risk vendor → escalate
  baseFacts({ recent_txn_count: 6, velocity_limit: 6 }), // E3: velocity → escalate
  baseFacts({ duplicate_recent_count: 1 }), // E4: possible duplicate → escalate
];

const skipReason = !isWasmKernelAvailable() ? "wasm/pkg not built — run build:wasm" : false;

test("parity: reference and wasm kernels agree on every case", { skip: skipReason }, () => {
  const wasm = new WasmKernel();
  for (const facts of CASES) {
    const expected = referenceKernel.evaluate(facts);
    const actual = wasm.evaluate(facts);
    assert.deepEqual(
      actual,
      expected,
      `parity mismatch for request ${facts.request_id} (${facts.category}, amount ${facts.amount})`,
    );
  }
});

/** Deterministic xorshift RNG so any parity failure replays exactly. */
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

// The golden cases pin the named rules; this stress-tests the WHOLE space —
// budget lists in every shape, all three verdict tiers, boundary arithmetic — so
// a subtle divergence (fired-rule ORDER, an off-by-one, a reason typo) can't hide
// between the handful of golden rows. Valid integer facts only: the malformed-fact
// path is covered by the reference kernel's own tests, and Souffle/Rust use i64 so
// NaN/Infinity aren't representable there anyway.
test("PARITY: reference and wasm kernels agree across 4000 randomized fact sets", { skip: skipReason }, () => {
  const wasm = new WasmKernel();
  const rng = makeRng(0x1701d);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const int = (max: number) => Math.floor(rng() * max);
  const CATS = ["office_supplies", "software", "travel", "crypto", ""];
  const VENDORS = ["acme_corp", "sketchy_llc", "newco_ltd", ""];

  for (let i = 0; i < 4000; i++) {
    const facts: Facts = {
      request_id: `req_${i}`,
      requesting_agent: pick(["agent_47", "agent_12", "agent_ghost"]),
      amount: int(3000),
      vendor: pick(VENDORS),
      category: pick(CATS),
      vendor_verified: rng() > 0.4,
      daily_total_so_far: int(3000),
      per_txn_cap: int(1200),
      daily_limit: int(3000),
      approved_categories: CATS.filter(() => rng() > 0.5),
      agent_cleared_categories: CATS.filter(() => rng() > 0.5),
      attestation_present: rng() > 0.3,
      escalation_threshold: int(1000),
      vendor_risk_tier: pick(["standard", "elevated", "trusted", "unknown"]),
      recent_txn_count: int(20),
      velocity_limit: pick([2, 6, 10]) as number,
      duplicate_recent_count: pick([0, 1, 2]) as number,
      budgets: Array.from({ length: int(4) }, () => ({
        scope: pick(["category_daily", "vendor_daily", "agent_monthly"]),
        key: pick(["office_supplies", "acme_corp", "agent_47", ""]),
        limit: int(2000),
        spent: int(2000),
      })).sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope.localeCompare(b.scope))),
    };
    const expected = referenceKernel.evaluate(facts);
    const actual = wasm.evaluate(facts);
    assert.deepEqual(actual, expected, `parity mismatch on case ${i}: ${JSON.stringify(facts)}`);
  }
});

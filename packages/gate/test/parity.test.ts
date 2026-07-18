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
    agent_identity_verified: true,
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
  baseFacts({ agent_identity_verified: false }), // D8: unauthenticated agent
  // Every deny at once — pins the full fixed ordering across both kernels.
  baseFacts({
    vendor: "sketchy_llc",
    vendor_verified: false,
    amount: 999,
    category: "crypto",
    attestation_present: false,
    agent_identity_verified: false,
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

test("parity: reference and wasm kernels agree on every case", { skip: !isWasmKernelAvailable() ? "wasm/pkg not built — run build:wasm" : false }, () => {
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

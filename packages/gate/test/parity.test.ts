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

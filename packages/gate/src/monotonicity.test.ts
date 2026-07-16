/**
 * @ramp/gate — amount-monotonicity, the invariant `explain` (and friends) rely on.
 *
 * Three shipped features probe the kernel by BINARY-SEARCHING over the amount:
 *   - `explain`'s counterfactual (largest amount that would ALLOW a stopped payment),
 *   - `explain`'s safety margin (smallest amount that would STOP an allowed one),
 *   - `simulate` / `policy-diff` reason about amounts the same way.
 *
 * Every one of them assumes the same thing: **raising the amount never improves the
 * verdict.** On the deny > escalate > allow lattice, `severity(evaluate(facts@a))`
 * is monotone NON-DECREASING in `a`. If a future rule ever broke that — say an
 * "allow large strategic purchases" carve-out — those binary searches would return
 * confidently wrong answers, and nothing else would notice. This test is the
 * tripwire: it fails CI the moment the kernel stops being amount-monotone.
 *
 * Scope: the invariant holds for VALID amounts (finite, non-negative integers),
 * which is exactly the domain the searches operate in. NaN/Infinity/floats trip
 * `deny/malformed_facts` (D0) and are covered by the parity + hostile-input tests,
 * not here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Facts, DecisionOutcome } from "@ramp/shared";
import { referenceKernel } from "./reference-kernel.js";

/** Deterministic xorshift RNG so any failure replays exactly. */
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

function severity(o: DecisionOutcome): number {
  return o === "deny" ? 2 : o === "escalate" ? 1 : 0;
}

const CATEGORIES = ["office_supplies", "software", "travel", "crypto", ""];
const VENDORS = ["acme_corp", "sketchy_llc", ""];

/** A random but STRUCTURALLY VALID fact set (all numerics are whole ≥ 0). `amount` is set by the caller. */
function randomValidFacts(rng: () => number, i: number): Facts {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const int = (max: number) => Math.floor(rng() * max);
  return {
    request_id: `req_${i}`,
    requesting_agent: pick(["agent_47", "agent_12", "agent_ghost"]),
    amount: 0, // overridden per probe
    vendor: pick(VENDORS),
    category: pick(CATEGORIES),
    vendor_verified: rng() > 0.5,
    daily_total_so_far: int(3000),
    per_txn_cap: int(1200),
    daily_limit: int(3000),
    approved_categories: CATEGORIES.filter(() => rng() > 0.5),
    agent_cleared_categories: CATEGORIES.filter(() => rng() > 0.5),
    attestation_present: rng() > 0.5,
    escalation_threshold: int(1000),
    vendor_risk_tier: pick(["standard", "elevated", "trusted", "unknown"]),
    recent_txn_count: int(20),
    velocity_limit: pick([2, 6, 10, 2147483647]) as number,
    duplicate_recent_count: pick([0, 1, 2]) as number,
    budgets: Array.from({ length: int(4) }, () => ({
      scope: pick(["category_daily", "vendor_daily", "agent_monthly"]),
      key: pick(["office_supplies", "acme_corp", "agent_47", ""]),
      limit: int(2000),
      spent: int(2000),
    })).sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope.localeCompare(b.scope))),
  };
}

test("PROPERTY: raising the amount never improves the verdict (amount-monotonicity)", () => {
  const rng = makeRng(0x6011);
  // A fixed ascending ladder of amounts, plus randomized ones, probed per fact set.
  for (let i = 0; i < 3000; i++) {
    const facts = randomValidFacts(rng, i);
    // Ascending amounts spanning below/at/above the caps in these facts.
    const amounts = [0, 1, 50, 100, 250, 400, 500, 800, 1200, 2000, 3000];
    let prev = -1;
    for (const amount of amounts) {
      const sev = severity(referenceKernel.evaluate({ ...facts, amount }).decision);
      assert.ok(
        sev >= prev,
        `monotonicity violated: facts=${JSON.stringify(facts)} — severity dropped from ` +
          `${prev} to ${sev} when amount rose to ${amount}`,
      );
      prev = sev;
    }
  }
});

test("PROPERTY: lowering the amount never worsens the verdict (the mirror, exhaustive small range)", () => {
  // The explain counterfactual searches DOWN; assert the dual directly on a dense
  // integer range so an off-by-one rule (e.g. `>=` vs `>`) can't hide between the
  // sparse ladder rungs above.
  const rng = makeRng(0xC0FFEE);
  for (let i = 0; i < 500; i++) {
    const facts = randomValidFacts(rng, i);
    let prev = 3; // higher than any severity
    for (let amount = 600; amount >= 0; amount--) {
      const sev = severity(referenceKernel.evaluate({ ...facts, amount }).decision);
      assert.ok(
        sev <= prev,
        `mirror violated: severity rose to ${sev} (was ${prev}) when amount fell to ${amount} — ` +
          `facts=${JSON.stringify(facts)}`,
      );
      prev = sev;
    }
  }
});

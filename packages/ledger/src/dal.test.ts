/**
 * @ramp/ledger — dal.test.ts
 *
 * Verifies the seeded hackathon scenario end-to-end against a real, freshly
 * provisioned in-memory SQLite DB (schema + seed), through the authoritative DAL.
 * Run with `node --test` (Node 24 built-in test runner + node:sqlite).
 *
 * Asserted ground truth (from sql/seed.sql):
 *   - agent_47 daily total so far = 1140 (~$1200 headline; NOT 1200 exactly —
 *     the reconciled seed is 600 + 540 so 340 more still allows under 1500).
 *   - acme_corp is verified; sketchy_llc / unknown_labs / missing are NOT.
 *   - caps: per_txn_cap 500, daily_limit 1500.
 *   - approved categories: office_supplies, software, travel (crypto NOT approved).
 *   - agent_47 cleared: office_supplies, software (NOT travel).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import { LedgerFactSource, UnknownAgentError } from "./dal.js";
import { demoAgentKeypair } from "@ramp/attestation";

/** The canonical hero request from PITCH.md's demo beat 1. */
const HERO_REQUEST: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

function withSeededDb<T>(fn: (fs: LedgerFactSource) => T): T {
  // In-memory, fully provisioned (schema + seed) — throwaway per test.
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(new LedgerFactSource(db));
  } finally {
    closeLedger(db);
  }
}

test("agent_47 daily total so far is the reconciled seed 1140 (~$1200)", () => {
  withSeededDb((fs) => {
    assert.equal(fs.getDailyTotalSoFar("agent_47"), 1140);
  });
});

test("a REGISTERED agent with no spend today totals 0", () => {
  withSeededDb((fs) => {
    // agent_12 exists in the registry and simply hasn't spent — an authoritative zero.
    assert.equal(fs.getDailyTotalSoFar("agent_12"), 0);
  });
});

test("an UNKNOWN agent throws rather than reading as zero spend (fail-closed)", () => {
  withSeededDb((fs) => {
    // The distinction this test protects: "spent nothing" and "I have never heard
    // of this identity" must not produce the same number. Returning 0 here would
    // hand an unprovisioned agent a full fresh daily budget.
    assert.throws(() => fs.getDailyTotalSoFar("agent_ghost"), UnknownAgentError);
    assert.throws(
      () => fs.contextFor({ request: { ...HERO_REQUEST, requestingAgent: "agent_ghost" } }),
      UnknownAgentError,
    );
  });
});

test("acme_corp is verified; unverified/missing vendors are not", () => {
  withSeededDb((fs) => {
    assert.equal(fs.isVendorVerified("acme_corp"), true);
    assert.equal(fs.isVendorVerified("sketchy_llc"), false);
    assert.equal(fs.isVendorVerified("unknown_labs"), false);
    assert.equal(fs.isVendorVerified("does_not_exist"), false);
  });
});

test("org limits are per_txn_cap 500 / daily_limit 1500 USD", () => {
  withSeededDb((fs) => {
    const limits = fs.getLimits();
    assert.equal(limits.perTxnCap, 500);
    assert.equal(limits.dailyLimit, 1500);
    assert.equal(limits.currency, "USD");
  });
});

test("approved categories exclude crypto", () => {
  withSeededDb((fs) => {
    const approved = fs.getApprovedCategories();
    assert.deepEqual(approved, ["automation", "office_supplies", "software", "subscriptions", "travel"]);
    assert.ok(!approved.includes("crypto"));
  });
});

test("agent_47 is cleared for office_supplies + software, NOT travel", () => {
  withSeededDb((fs) => {
    const cleared = fs.getAgentClearances("agent_47");
    assert.deepEqual(cleared, ["office_supplies", "software"]);
    assert.ok(!cleared.includes("travel"));
  });
});

test("contextFor assembles the authoritative context for the hero request", () => {
  withSeededDb((fs) => {
    const req = HERO_REQUEST;
    const ctx = fs.contextFor({ request: req });
    assert.equal(ctx.vendorVerified, true);
    assert.equal(ctx.dailyTotalSoFar, 1140);
    assert.equal(ctx.perTxnCap, 500);
    assert.equal(ctx.dailyLimit, 1500);
    assert.deepEqual(ctx.approvedCategories, [
      "automation",
      "office_supplies",
      "software",
      "subscriptions",
      "travel",
    ]);
    assert.deepEqual(ctx.agentClearedCategories, [
      "office_supplies",
      "software",
    ]);
    // The hero happy path: 1140 + 340 = 1480 <= 1500 (allow) and 340 <= 500 (cap).
    assert.ok(ctx.dailyTotalSoFar + req.amount <= ctx.dailyLimit);
    assert.ok(req.amount <= ctx.perTxnCap);
  });
});

test("contextFor keys off untrusted request fields only as lookup keys", () => {
  withSeededDb((fs) => {
    // A spoofed request naming an unverified vendor + unapproved category must
    // surface the AUTHORITATIVE facts (not the caller's assertions).
    const spoof: SpendRequest = {
      vendorId: "sketchy_llc",
      amount: 999,
      currency: "USD",
      category: "crypto",
      requestingAgent: "agent_47",
    };
    const ctx = fs.contextFor({ request: spoof });
    assert.equal(ctx.vendorVerified, false);
    assert.ok(!ctx.approvedCategories.includes("crypto"));
  });
});

test("attestationPresent comes from the caller's verified verdict, never the request", () => {
  withSeededDb((fs) => {
    // Absent verdict => false (fail-closed default).
    assert.equal(fs.contextFor({ request: HERO_REQUEST }).attestationPresent, false);
    // A verified verdict is threaded in by the attestation layer, out of band.
    assert.equal(
      fs.contextFor({ request: HERO_REQUEST, attestationPresent: true })
        .attestationPresent,
      true,
    );
    // There is no field on SpendRequest that can set this. A request that tries
    // to assert it is simply ignored — the property is not read from the request.
    const liar = { ...HERO_REQUEST, attestationPresent: true } as SpendRequest;
    assert.equal(fs.contextFor({ request: liar }).attestationPresent, false);
  });
});

// ---------------------------------------------------------------------------
// Budgets (policy.dl D7). The seam where two mechanisms meet.
// ---------------------------------------------------------------------------

test("THE SEAM: the ledger never emits an agent_daily budget line", () => {
  // `agent_daily` belongs to daily_limit/daily_total_so_far (D5). A line here
  // would mean two mechanisms speaking about one budget, free to disagree — the
  // exact duplication the generic budget list exists to avoid everywhere else.
  // The schema CHECKs it; this asserts the DAL never surfaces one either, because
  // one guard is a hope.
  withSeededDb((fs) => {
    for (const [cat, vend] of [
      ["office_supplies", "acme_corp"],
      ["software", "acme_corp"],
      ["crypto", "sketchy_llc"],
    ] as const) {
      const lines = fs.getBudgetsFor(cat, vend, "agent_47");
      assert.ok(
        !lines.some((b) => b.scope === "agent_daily"),
        `agent_daily leaked into the budget list for ${cat}/${vend}`,
      );
    }
  });
});

test("the schema REFUSES an agent_daily budget row", () => {
  withSeededDb((fs) => {
    assert.throws(
      () =>
        (fs as unknown as { _db: never }) &&
        openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true }).exec(
          "INSERT INTO budgets (scope, key, limit_amount) VALUES ('agent_daily', 'agent_47', 99)",
        ),
      /CHECK constraint failed/,
    );
  });
});

test("budgets arrive sorted by (scope, key) — ordering is load-bearing", () => {
  // The kernel emits one reason per broken budget IN LIST ORDER. An unsorted list
  // would make the SAME facts yield a different Decision depending on SQLite's row
  // order — the exact non-determinism the design rules out, invisible until a
  // bundle failed to re-verify on someone else's machine.
  withSeededDb((fs) => {
    const lines = fs.getBudgetsFor("office_supplies", "acme_corp", "agent_47");
    const keys = lines.map((b) => `${b.scope}:${b.key}`);
    assert.deepEqual(keys, [...keys].sort(), "budget lines must be deterministically ordered");
    // And repeated reads agree.
    assert.deepEqual(fs.getBudgetsFor("office_supplies", "acme_corp", "agent_47"), lines);
  });
});

test("only the budgets that APPLY to this request are returned", () => {
  withSeededDb((fs) => {
    const lines = fs.getBudgetsFor("software", "newco_ltd", "agent_47");
    assert.deepEqual(
      lines.map((b) => `${b.scope}:${b.key}`).sort(),
      ["category_daily:software", "vendor_daily:newco_ltd"],
      "a request must not be measured against other categories' budgets",
    );
  });
});

test("budget `spent` is an authoritative ledger read", () => {
  withSeededDb((fs) => {
    // seed: agent_47 spent 600 on office_supplies and 540 on software today.
    const office = fs
      .getBudgetsFor("office_supplies", "acme_corp", "agent_47")
      .find((b) => b.scope === "category_daily");
    assert.equal(office?.spent, 600);
    const software = fs
      .getBudgetsFor("software", "acme_corp", "agent_47")
      .find((b) => b.scope === "category_daily");
    assert.equal(software?.spent, 540);
  });
});

test("a budget with an UNMEASURABLE scope throws — it must not be silently ignored", () => {
  // The bug this pins was found by writing this test. The budget query used to
  // enumerate ('category_daily','vendor_daily') in its WHERE clause, so a row with
  // any other scope was never selected — you could add a quarterly budget, see it
  // sitting in the table, and it would never once be enforced. A
  // configured-but-unenforced budget is worse than no budget: it is a control
  // everyone believes in and nobody has.
  //
  // Now it is selected and throws, which the hook turns into a DENY. Loud beats
  // silent: an operator who adds a budget the gate cannot measure should find out
  // immediately, not during an incident review.
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    db.exec("INSERT INTO budgets (scope, key, limit_amount) VALUES ('quarterly', 'agent_47', 10)");
    const fs = new LedgerFactSource(db);
    assert.throws(
      () => fs.getBudgetsFor("office_supplies", "acme_corp", "agent_47"),
      /no spend query for budget scope "quarterly"/,
    );
  } finally {
    closeLedger(db);
  }
});

// ---------------------------------------------------------------------------
// Windowed budgets (D7 generalised over periods).
// ---------------------------------------------------------------------------

test("a monthly budget sees spend that the daily/weekly windows cannot", () => {
  // agent_12 spent 1700 on travel 12 and 20 days ago (this rolling month, but not
  // this week, not today). The whole point of windows: a monthly budget catches
  // accumulation a daily one is blind to.
  withSeededDb((fs) => {
    const b = fs.getBudgetsFor("travel", "acme_corp", "agent_12");
    const daily = b.find((x) => x.scope === "category_daily")!;
    const weekly = b.find((x) => x.scope === "category_weekly")!;
    const monthly = b.find((x) => x.scope === "category_monthly")!;
    assert.equal(daily.spent, 0, "nothing today");
    assert.equal(weekly.spent, 0, "nothing in the last 7 days");
    assert.equal(monthly.spent, 1700, "but 1700 in the last 30 days");
  });
});

test("windowed scopes are still generic — no new rule, just a period fragment", () => {
  // The same getBudgetsFor path returns weekly and monthly lines with no
  // per-period code; the kernel compares them like any other budget.
  withSeededDb((fs) => {
    const scopes = fs
      .getBudgetsFor("travel", "acme_corp", "agent_12")
      .map((b) => b.scope)
      .sort();
    assert.ok(scopes.includes("category_weekly"));
    assert.ok(scopes.includes("category_monthly"));
  });
});

test("an unmeasurable PERIOD throws, same as an unmeasurable subject", () => {
  // 'category_quarterly' has no period fragment. It must not read as zero spend —
  // an unlimited budget nobody configured.
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    db.exec("INSERT INTO budgets (scope, key, limit_amount) VALUES ('category_quarterly', 'travel', 10)");
    const fs = new LedgerFactSource(db);
    assert.throws(
      () => fs.getBudgetsFor("travel", "acme_corp", "agent_12"),
      /no spend query for budget scope "category_quarterly"/,
    );
  } finally {
    closeLedger(db);
  }
});

// ---------------------------------------------------------------------------
// Duplicate detection (E4).
// ---------------------------------------------------------------------------

test("a matching settled payment is counted as a possible duplicate", () => {
  // The seed has agent_12 -> acme_corp -> subscriptions -> 120 half an hour ago.
  withSeededDb((fs) => {
    const dup = fs.getDuplicateCount("acme_corp", 120, "subscriptions", 1440);
    assert.equal(dup, 1, "the identical prior payment must be seen");
  });
});

test("a different amount/vendor/category is NOT a duplicate", () => {
  withSeededDb((fs) => {
    assert.equal(fs.getDuplicateCount("acme_corp", 121, "subscriptions", 1440), 0, "amount differs");
    assert.equal(fs.getDuplicateCount("newco_ltd", 120, "subscriptions", 1440), 0, "vendor differs");
    assert.equal(fs.getDuplicateCount("acme_corp", 120, "office_supplies", 1440), 0, "category differs");
  });
});

test("a duplicate outside the window is not counted", () => {
  withSeededDb((fs) => {
    // The seed payment is 30 min old; a 10-minute window excludes it.
    assert.equal(fs.getDuplicateCount("acme_corp", 120, "subscriptions", 10), 0);
    assert.equal(fs.getDuplicateCount("acme_corp", 120, "subscriptions", 60), 1);
  });
});

// ---------------------------------------------------------------------------
// Agent identity registry (D8).
// ---------------------------------------------------------------------------

test("the seeded registry PEMs match the demo derivation BYTE FOR BYTE", () => {
  // sql/seed.sql carries the public keys as literals; @ramp/attestation derives
  // the keypairs from published constants. If either side moves, the demo signs
  // with keys the registry doesn't hold and every beat denies on
  // deny/unauthenticated_agent. Pin the seam here, loudly.
  withSeededDb((fs) => {
    for (const id of ["agent_47", "agent_12", "agent_burst", "agent_dup"]) {
      assert.equal(
        fs.getAgentPublicKey(id),
        demoAgentKeypair(id).publicKeyPem,
        `seeded PEM for ${id} drifted from demoAgentKeypair's derivation`,
      );
    }
  });
});

test("an unregistered agent has no key — null, never a default", () => {
  withSeededDb((fs) => {
    assert.equal(fs.getAgentPublicKey("agent_ghost"), null);
  });
});

test("a REVOKED agent's key is unfetchable — revocation is a row update", () => {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    const fs = new LedgerFactSource(db);
    assert.notEqual(fs.getAgentPublicKey("agent_47"), null);
    db.prepare("UPDATE agent_registry SET status = 'revoked' WHERE agent_id = ?").run(
      "agent_47",
    );
    // The key still EXISTS in the table; it must nonetheless be unfetchable —
    // the 'active' filter lives inside the query, not in caller diligence.
    assert.equal(fs.getAgentPublicKey("agent_47"), null);
  } finally {
    closeLedger(db);
  }
});

test("the identity verdict flows through contextFor from the CONTEXT, never the request", () => {
  withSeededDb((fs) => {
    // Same request, different out-of-band verdicts: only the context moves the fact.
    const withVerdict = fs.contextFor({ request: HERO_REQUEST, agentIdentityVerified: true });
    assert.equal(withVerdict.agentIdentityVerified, true);
    const without = fs.contextFor({ request: HERO_REQUEST });
    assert.equal(without.agentIdentityVerified, false, "absent verdict must fail closed");
  });
});

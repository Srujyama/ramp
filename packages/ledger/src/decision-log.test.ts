/**
 * @ramp/ledger — decision-log.test.ts
 *
 * Exercises the audit trail: atomic + idempotent writes, verbatim preservation
 * of the frozen Decision (outcome + fired-rule order), the read-only query API
 * (filters + deterministic keyset pagination), corruption handling, and the
 * SQLite concurrency behaviour (WAL readers-during-writes, busy contention,
 * rollback-leaves-no-partial). Run with `node --test` (Node 24 + node:sqlite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SpendRequest, Facts, Decision, RuleId } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import {
  recordDecision,
  getDecision,
  listDecisions,
  MAX_LIMIT,
} from "./decision-log.js";

// --- fixtures ----------------------------------------------------------------

const heroReq: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

function facts(over: Partial<Facts> = {}): Facts {
  return {
    request_id: "inv_2026_07_0043",
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
    attestation_present: false,
    escalation_threshold: 400,
    vendor_risk_tier: "standard",
    ...over,
  };
}

const ALLOW: Decision = {
  decision: "allow",
  reasons: ["allow: every policy condition held"],
  firedRules: ["allow/all_conditions_met"],
};

function deny(rules: RuleId[]): Decision {
  return {
    decision: "deny",
    reasons: rules.map((r) => `denied: ${r}`),
    firedRules: rules,
  };
}

/** Fresh, fully-provisioned in-memory ledger; disposed after `fn`. */
function withDb<T>(fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

/** Fresh on-disk ledger (needed for cross-connection concurrency tests). */
function withFileDb<T>(fn: (path: string) => T): T {
  const path = join(tmpdir(), `ramp-declog-${randomUUID()}.db`);
  try {
    return fn(path);
  } finally {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      rmSync(p, { force: true });
    }
  }
}

// --- persistence: allow + the five deny rules --------------------------------

test("persists the hero ALLOW verbatim and reads it back", () => {
  withDb((db) => {
    const { decisionId, inserted } = recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: ALLOW,
      kernelId: "ts-reference",
    });
    assert.equal(inserted, true);

    const rec = getDecision(db, decisionId);
    assert.ok(rec);
    assert.equal(rec.status, "allowed");
    assert.equal(rec.outcome, "allow");
    assert.equal(rec.agentId, "agent_47");
    assert.equal(rec.vendorId, "acme_corp");
    assert.equal(rec.amount, 340);
    assert.equal(rec.category, "office_supplies");
    assert.equal(rec.attestationPresent, false);
    assert.equal(rec.kernelId, "ts-reference");
    assert.deepEqual(rec.decision, ALLOW);
    assert.deepEqual(rec.firedRules, ["allow/all_conditions_met"]);
    assert.equal(rec.corrupt, false);
    // request + facts round-trip verbatim.
    assert.deepEqual(rec.request, heroReq);
    assert.equal(rec.facts?.daily_total_so_far, 1140);
  });
});

const DENY_RULES: RuleId[] = [
  "deny/vendor_not_verified",
  "deny/over_per_txn_cap",
  "deny/agent_uncleared_for_category",
  "deny/category_not_approved",
  "deny/daily_limit_exceeded",
];

for (const rule of DENY_RULES) {
  test(`persists a single-rule deny (${rule}) exactly`, () => {
    withDb((db) => {
      const { decisionId } = recordDecision(db, {
        request: heroReq,
        facts: facts(),
        decision: deny([rule]),
      });
      const rec = getDecision(db, decisionId);
      assert.equal(rec?.status, "denied");
      assert.equal(rec?.outcome, "deny");
      assert.deepEqual(rec?.firedRules, [rule]);
    });
  });
}

test("preserves fired-rule ORDER and stores every rule (multi-deny)", () => {
  withDb((db) => {
    // Deliberately NOT in the kernel's canonical order — persistence must store
    // exactly what it is handed, never reorder.
    const rules: RuleId[] = [
      "deny/daily_limit_exceeded",
      "deny/vendor_not_verified",
      "deny/over_per_txn_cap",
    ];
    const { decisionId } = recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: deny(rules),
    });
    const rec = getDecision(db, decisionId);
    assert.deepEqual(rec?.firedRules, rules);
    assert.equal(rec?.decision?.firedRules.length, 3);
  });
});

// --- idempotency + duplicate request ids -------------------------------------

test("idempotent: repeated delivery of the same decision_id is a no-op", () => {
  withDb((db) => {
    const id = randomUUID();
    const first = recordDecision(db, {
      decisionId: id,
      request: heroReq,
      facts: facts(),
      decision: deny(["deny/vendor_not_verified"]),
    });
    assert.equal(first.inserted, true);

    // Re-deliver the identical result — must NOT insert or overwrite.
    const second = recordDecision(db, {
      decisionId: id,
      request: heroReq,
      facts: facts(),
      decision: deny(["deny/vendor_not_verified"]),
    });
    assert.equal(second.inserted, false);

    const all = listDecisions(db, {});
    assert.equal(all.decisions.length, 1);
    // Exactly one set of fired rules — the child rows weren't duplicated.
    assert.deepEqual(all.decisions[0]?.firedRules, ["deny/vendor_not_verified"]);
  });
});

test("distinct attempts sharing one request_id are BOTH recorded", () => {
  withDb((db) => {
    const a = recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: ALLOW,
      requestId: "req_shared",
    });
    const b = recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: deny(["deny/daily_limit_exceeded"]),
      requestId: "req_shared",
    });
    assert.notEqual(a.decisionId, b.decisionId);
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, true);
    assert.equal(listDecisions(db, {}).decisions.length, 2);
  });
});

// --- explicit failures (never silently drop / fabricate) ---------------------

test("refuses to fabricate: malformed decision throws", () => {
  withDb((db) => {
    assert.throws(
      () =>
        recordDecision(db, {
          request: heroReq,
          // deliberately malformed
          decision: { decision: "maybe" } as unknown as Decision,
        }),
      /malformed/,
    );
    assert.equal(listDecisions(db, {}).decisions.length, 0);
  });
});

test("refuses to invent a decision when neither decision nor error status given", () => {
  withDb((db) => {
    assert.throws(
      () => recordDecision(db, { request: heroReq }),
      /Refusing to invent/,
    );
  });
});

test("records an infra failure as an explicit error row (not a policy deny)", () => {
  withDb((db) => {
    const { decisionId } = recordDecision(db, {
      request: heroReq,
      status: "error",
      requestId: "req_err",
    });
    const rec = getDecision(db, decisionId);
    assert.equal(rec?.status, "error");
    assert.equal(rec?.outcome, null);
    assert.deepEqual(rec?.firedRules, []);
    assert.equal(rec?.corrupt, false); // an error row is valid, not corrupt
  });
});

test("a failed transaction leaves NO partial record (atomic rollback)", () => {
  withDb((db) => {
    // Force the fired-rule insert to fail mid-transaction by removing its table.
    db.exec("ALTER TABLE decision_fired_rules RENAME TO _gone");
    assert.throws(() =>
      recordDecision(db, {
        request: heroReq,
        facts: facts(),
        decision: deny(["deny/vendor_not_verified"]),
      }),
    );
    // The parent row must have rolled back — no orphaned decision.
    const n = db.prepare("SELECT count(*) AS n FROM decisions").get() as {
      n: number;
    };
    assert.equal(n.n, 0);
  });
});

// --- corruption vs. a genuine deny -------------------------------------------

test("distinguishes a CORRUPT stored blob from a valid denied decision", () => {
  withDb((db) => {
    const good = recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: deny(["deny/category_not_approved"]),
    });
    // A genuine deny is not corrupt.
    assert.equal(getDecision(db, good.decisionId)?.corrupt, false);

    // Corrupt the stored decision JSON out-of-band.
    db.prepare("UPDATE decisions SET decision_json = ? WHERE decision_id = ?").run(
      "{not valid json",
      good.decisionId,
    );
    const rec = getDecision(db, good.decisionId);
    assert.equal(rec?.corrupt, true);
    assert.equal(rec?.decision, null);
    // The row is still identifiable (outcome column intact) but flagged corrupt.
    assert.equal(rec?.outcome, "deny");
  });
});

// --- read-only query API: filters --------------------------------------------

test("filters by agent, vendor, outcome, and fired rule", () => {
  withDb((db) => {
    recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: ALLOW,
    });
    recordDecision(db, {
      request: { ...heroReq, requestingAgent: "agent_99", vendorId: "sketchy_llc" },
      facts: facts(),
      decision: deny(["deny/vendor_not_verified"]),
    });

    assert.equal(listDecisions(db, { agentId: "agent_47" }).decisions.length, 1);
    assert.equal(listDecisions(db, { vendorId: "sketchy_llc" }).decisions.length, 1);
    assert.equal(listDecisions(db, { outcome: "allow" }).decisions.length, 1);
    assert.equal(listDecisions(db, { outcome: "deny" }).decisions.length, 1);
    assert.equal(
      listDecisions(db, { firedRule: "deny/vendor_not_verified" }).decisions.length,
      1,
    );
    assert.equal(
      listDecisions(db, { firedRule: "deny/over_per_txn_cap" }).decisions.length,
      0,
    );
  });
});

test("filters by time range (half-open [since, until))", () => {
  withDb((db) => {
    recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: ALLOW,
      ts: "2026-07-10 09:00:00",
    });
    recordDecision(db, {
      request: heroReq,
      facts: facts(),
      decision: ALLOW,
      ts: "2026-07-12 09:00:00",
    });
    const inRange = listDecisions(db, {
      since: "2026-07-11 00:00:00",
      until: "2026-07-13 00:00:00",
    });
    assert.equal(inRange.decisions.length, 1);
    assert.equal(inRange.decisions[0]?.ts, "2026-07-12 09:00:00");
  });
});

// --- deterministic keyset pagination -----------------------------------------

test("paginates deterministically across EQUAL timestamps (no dup/skip)", () => {
  withDb((db) => {
    const N = 12;
    const ts = "2026-07-13 12:00:00"; // identical for every row
    for (let i = 0; i < N; i++) {
      recordDecision(db, {
        request: heroReq,
        facts: facts(),
        decision: ALLOW,
        ts,
      });
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listDecisions(db, { limit: 5, cursor });
      for (const d of page.decisions) {
        assert.ok(!seen.has(d.decisionId), "no row appears on two pages");
        seen.add(d.decisionId);
      }
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages <= 10, "pagination terminates");
    } while (cursor);

    assert.equal(seen.size, N); // every row seen exactly once
  });
});

test("limit is clamped to MAX_LIMIT and defaults sanely", () => {
  withDb((db) => {
    for (let i = 0; i < 3; i++) {
      recordDecision(db, { request: heroReq, facts: facts(), decision: ALLOW });
    }
    assert.equal(listDecisions(db, { limit: 10_000 }).decisions.length, 3);
    assert.equal(listDecisions(db, { limit: 0 }).decisions.length, 1); // clamped to >=1
  });
});

test("rejects a malformed pagination cursor explicitly", () => {
  withDb((db) => {
    assert.throws(
      () => listDecisions(db, { cursor: "not-a-real-cursor!!" }),
      /malformed cursor/,
    );
  });
});

// --- concurrency (on-disk, cross-connection) ---------------------------------

test("many inserts across two connections: none lost", () => {
  withFileDb((path) => {
    const w1 = openLedger(path);
    const w2 = openLedger(path);
    try {
      const N = 40;
      for (let i = 0; i < N; i++) {
        const db = i % 2 === 0 ? w1 : w2;
        recordDecision(db, { request: heroReq, facts: facts(), decision: ALLOW });
      }
      // Read the definitive count from a third connection.
      const r = openLedger(path, { provisionIfEmpty: false });
      try {
        const n = r.prepare("SELECT count(*) AS n FROM decisions").get() as {
          n: number;
        };
        assert.equal(n.n, N);
      } finally {
        closeLedger(r);
      }
    } finally {
      closeLedger(w1);
      closeLedger(w2);
    }
  });
});

test("a reader during writes sees consistent, monotonic, non-partial state", () => {
  withFileDb((path) => {
    const writer = openLedger(path);
    const reader = openLedger(path, { provisionIfEmpty: false });
    try {
      let last = 0;
      for (let i = 0; i < 15; i++) {
        recordDecision(writer, { request: heroReq, facts: facts(), decision: ALLOW });
        const page = listDecisions(reader, { limit: MAX_LIMIT });
        // Never negative, never skips, and every visible row is fully-formed.
        assert.ok(page.decisions.length >= last);
        for (const d of page.decisions) {
          assert.equal(d.corrupt, false);
          assert.ok(d.request !== null);
        }
        last = page.decisions.length;
      }
      assert.equal(last, 15);
    } finally {
      closeLedger(writer);
      closeLedger(reader);
    }
  });
});

test("write contention surfaces explicitly (SQLITE_BUSY), never silent loss", () => {
  withFileDb((path) => {
    const holder = openLedger(path);
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 100;"); // fail fast for the test
    try {
      // `holder` grabs the write lock and keeps it.
      holder.exec("BEGIN IMMEDIATE");
      holder.prepare(
        "INSERT INTO decisions (decision_id, request_id, status, agent_id, vendor_id, amount, category, request_json, content_digest) " +
          "VALUES (?, ?, 'allowed', 'a', 'v', 1, 'c', '{}', 'x')",
      ).run(randomUUID(), "r");

      // A second writer must NOT silently succeed or drop the row — it errors.
      assert.throws(
        () =>
          contender
            .prepare(
              "INSERT INTO decisions (decision_id, request_id, status, agent_id, vendor_id, amount, category, request_json) " +
                "VALUES (?, ?, 'allowed', 'a', 'v', 1, 'c', '{}')",
            )
            .run(randomUUID(), "r"),
        /busy|locked/i,
      );

      holder.exec("ROLLBACK");
    } finally {
      contender.close();
      closeLedger(holder);
    }
  });
});

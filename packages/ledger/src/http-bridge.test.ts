/**
 * @ramp/ledger — http-bridge.test.ts
 *
 * Exercises the READ-ONLY dashboard bridge end-to-end over a real ephemeral
 * `node:http` socket (`listen(0)`), seeding an in-memory ledger. Every server is
 * `.close()`d in a `finally` — no server is ever left running.
 *
 * Covers: list, detail, filters, keyset pagination, invalid cursor, limit
 * clamping, not-found, malformed query, CORS (allowed + rejected), unsupported
 * methods, and the proof/corruption trust fields (present / missing / corrupt
 * proof, and corrupt request/decision JSON). Run `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH, type LedgerDb } from "./db.js";
import { recordDecision, recordExecution } from "./decision-log.js";
import { buildProof } from "./proof.js";
import { createLedgerBridge } from "./http-bridge.js";

const ORIGIN = "http://localhost:5173";

const req: SpendRequest = {
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
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: 6,
    ...over,
  };
}

const ALLOW: Decision = {
  decision: "allow",
  reasons: ["allow: every policy condition held"],
  firedRules: ["allow/all_conditions_met"],
};

const DENY: Decision = {
  decision: "deny",
  reasons: ["denied: deny/over_per_txn_cap"],
  firedRules: ["deny/over_per_txn_cap"],
};

/**
 * Seed an in-memory ledger, stand up the bridge on an ephemeral port, run the
 * test against a live socket, and ALWAYS close both the server and the DB.
 */
async function withBridge(
  seed: (db: LedgerDb) => void,
  run: (base: string, db: LedgerDb, server: Server) => Promise<void>,
  options?: { maxUrlLength?: number; maxBodyBytes?: number },
): Promise<void> {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  seed(db);
  const server = createLedgerBridge({
    db,
    allowedOrigin: ORIGIN,
    maxUrlLength: options?.maxUrlLength,
    maxBodyBytes: options?.maxBodyBytes,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`, db, server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeLedger(db);
  }
}

/** Insert N allow decisions with deterministic, strictly-increasing timestamps. */
function seedMany(db: LedgerDb, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `dec_${String(i).padStart(3, "0")}`;
    recordDecision(db, {
      decisionId: id,
      request: req,
      facts: facts(),
      decision: ALLOW,
      ts: `2026-07-14 10:00:${String(i).padStart(2, "0")}`,
    });
    ids.push(id);
  }
  return ids;
}

// --- list / detail / filters -------------------------------------------------

test("GET /decisions returns the seeded decisions", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "d1", request: req, facts: facts(), decision: ALLOW });
      recordDecision(db, { decisionId: "d2", request: req, facts: facts(), decision: DENY });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const body = (await res.json()) as { decisions: Array<{ decisionId: string }> };
      const ids = body.decisions.map((d) => d.decisionId).sort();
      assert.deepEqual(ids, ["d1", "d2"]);
    },
  );
});

test("GET /decisions/:id surfaces the sandbox execution receipt", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "paid", request: req, facts: facts(), decision: ALLOW });
      recordExecution(db, {
        decisionId: "paid",
        receiptId: "rcpt_http01",
        executionId: "exec_http01",
        status: "settled",
        provider: "sandbox",
      });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions/paid`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        execution: { receiptId: string; status: string; provider: string } | null;
      };
      assert.ok(body.execution);
      assert.equal(body.execution.receiptId, "rcpt_http01");
      assert.equal(body.execution.status, "settled");
      assert.equal(body.execution.provider, "sandbox");
    },
  );
});

test("GET /decisions/:id: a decision with no execution serves execution: null", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "unpaid", request: req, facts: facts(), decision: DENY });
    },
    async (base) => {
      const body = (await (await fetch(`${base}/decisions/unpaid`)).json()) as {
        execution: unknown;
      };
      assert.equal(body.execution, null);
    },
  );
});

test("GET /decisions/:id returns the single decision", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "only", request: req, facts: facts(), decision: ALLOW });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions/only`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { decisionId: string; outcome: string };
      assert.equal(body.decisionId, "only");
      assert.equal(body.outcome, "allow");
    },
  );
});

test("GET /decisions?status=denied filters the set", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "a_allow", request: req, facts: facts(), decision: ALLOW });
      recordDecision(db, { decisionId: "b_deny", request: req, facts: facts(), decision: DENY });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions?status=denied`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { decisions: Array<{ decisionId: string; status: string }> };
      assert.equal(body.decisions.length, 1);
      const [only] = body.decisions;
      assert.ok(only);
      assert.equal(only.decisionId, "b_deny");
      assert.equal(only.status, "denied");
    },
  );
});

test("GET /decisions?agentId= filters to that agent", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, {
        decisionId: "mine",
        request: { ...req, requestingAgent: "agent_47" },
        facts: facts(),
        decision: ALLOW,
      });
      recordDecision(db, {
        decisionId: "theirs",
        request: { ...req, requestingAgent: "agent_99" },
        facts: facts(),
        decision: ALLOW,
      });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions?agentId=agent_99`);
      const body = (await res.json()) as { decisions: Array<{ decisionId: string; agentId: string }> };
      assert.equal(body.decisions.length, 1);
      const [only] = body.decisions;
      assert.ok(only);
      assert.equal(only.decisionId, "theirs");
      assert.equal(only.agentId, "agent_99");
    },
  );
});

// --- keyset pagination -------------------------------------------------------

test("keyset pagination with limit=1 walks every row once (no dup/skip)", async () => {
  await withBridge(
    (db) => {
      seedMany(db, 3);
    },
    async (base) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const qs = new URLSearchParams({ limit: "1" });
        if (cursor !== undefined) qs.set("cursor", cursor);
        const res = await fetch(`${base}/decisions?${qs.toString()}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          decisions: Array<{ decisionId: string }>;
          nextCursor?: string;
        };
        assert.ok(body.decisions.length <= 1);
        for (const d of body.decisions) seen.push(d.decisionId);
        if (body.nextCursor === undefined) break;
        cursor = body.nextCursor;
      }
      // All three unique, no duplicates, no skips.
      assert.equal(seen.length, 3);
      assert.deepEqual([...new Set(seen)].sort(), ["dec_000", "dec_001", "dec_002"]);
    },
  );
});

test("invalid cursor → 400 bad_request", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "d1", request: req, facts: facts(), decision: ALLOW });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions?cursor=@@@`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; detail?: string };
      assert.equal(body.error, "bad_request");
      assert.equal(body.detail, "malformed cursor");
    },
  );
});

// --- limit clamping ----------------------------------------------------------

test("limit=99999 does not error and returns at most MAX_LIMIT rows", async () => {
  await withBridge(
    (db) => {
      seedMany(db, 5);
    },
    async (base) => {
      const res = await fetch(`${base}/decisions?limit=99999`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { decisions: unknown[] };
      // We only seeded 5, and MAX_LIMIT is 200 — either way, no error, bounded.
      assert.equal(body.decisions.length, 5);
    },
  );
});

test("limit=0 is clamped to >= 1 (not an error, returns a row)", async () => {
  await withBridge(
    (db) => {
      seedMany(db, 3);
    },
    async (base) => {
      const res = await fetch(`${base}/decisions?limit=0`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { decisions: unknown[]; nextCursor?: string };
      assert.equal(body.decisions.length, 1); // clamped to 1
      assert.ok(body.nextCursor !== undefined); // more pages exist
    },
  );
});

// --- errors ------------------------------------------------------------------

test("GET /decisions/nope → 404 not_found", async () => {
  await withBridge(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/decisions/nope`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "not_found");
    },
  );
});

test("unknown path → 404 not_found", async () => {
  await withBridge(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/nope/nope`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "not_found");
    },
  );
});

test("limit=abc → 400 bad_request (malformed query)", async () => {
  await withBridge(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/decisions?limit=abc`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "bad_request");
    },
  );
});

// --- CORS --------------------------------------------------------------------

test("allowed CORS origin → ACAO === allowedOrigin", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "d1", request: req, facts: facts(), decision: ALLOW });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions`, { headers: { Origin: ORIGIN } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
      await res.arrayBuffer(); // drain
    },
  );
});

test("rejected CORS origin → ACAO is NOT the evil origin", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "d1", request: req, facts: facts(), decision: ALLOW });
    },
    async (base) => {
      const evil = "http://evil.example";
      const res = await fetch(`${base}/decisions`, { headers: { Origin: evil } });
      const acao = res.headers.get("access-control-allow-origin");
      assert.notEqual(acao, evil);
      assert.notEqual(acao, "*");
      await res.arrayBuffer(); // drain
    },
  );
});

test("OPTIONS preflight from allowed origin → 204 with CORS + methods", async () => {
  await withBridge(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/decisions`, {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal(res.headers.get("access-control-allow-methods"), "GET, OPTIONS");
      await res.arrayBuffer();
    },
  );
});

// --- unsupported methods -----------------------------------------------------

test("POST /decisions → 405 method_not_allowed with Allow header", async () => {
  await withBridge(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/decisions`, { method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, OPTIONS");
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "method_not_allowed");
    },
  );
});

// --- proof / provenance / corruption trust fields ----------------------------

test("proof present → proofVerified true, proof non-null, provenance surfaced", async () => {
  await withBridge(
    (db) => {
      const id = "dec_proof";
      const proof = buildProof({
        decisionId: id,
        request: req,
        decision: ALLOW,
        facts: facts(),
        kernelId: "ts-reference",
        attestation: { status: "present_unverified" },
        producedAt: 1_700_000_000_000,
        provenance: {
          nodes: [
            { id: "n1", kind: "tool_call" },
            { id: "n2", kind: "derived" },
          ],
          edges: [{ parent: "n1", child: "n2" }],
        },
      });
      recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions/dec_proof`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        proofVerified: boolean;
        proof: unknown;
        provenance: unknown;
        corrupt: boolean;
        proofVerification: { proofPresent: boolean; reason: string };
      };
      assert.equal(body.proofVerified, true);
      assert.ok(body.proof !== null);
      assert.ok(body.provenance !== null); // surfaced top-level
      assert.equal(body.corrupt, false);
      assert.equal(body.proofVerification.proofPresent, true);
      assert.equal(body.proofVerification.reason, "ok");
    },
  );
});

test("proof missing → proofVerified false, proofPresent false, proof null (no crash)", async () => {
  await withBridge(
    (db) => {
      recordDecision(db, { decisionId: "dec_noproof", request: req, facts: facts(), decision: ALLOW });
    },
    async (base) => {
      const res = await fetch(`${base}/decisions/dec_noproof`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        proofVerified: boolean;
        proof: unknown;
        provenance: unknown;
        proofVerification: { proofPresent: boolean; reason: string };
      };
      assert.equal(body.proofVerified, false);
      assert.equal(body.proof, null);
      assert.equal(body.provenance, null);
      assert.equal(body.proofVerification.proofPresent, false);
    },
  );
});

test("corrupt stored proof → corrupt true, proofVerified false, still 200", async () => {
  await withBridge(
    (db) => {
      const id = "dec_corruptproof";
      const proof = buildProof({ decisionId: id, request: req, decision: ALLOW, producedAt: 1 });
      recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW, proof });
      // Corrupt the stored proof JSON out-of-band.
      db.prepare("UPDATE decision_proofs SET proof_json = ? WHERE decision_id = ?").run(
        "{ not valid json",
        id,
      );
    },
    async (base) => {
      const res = await fetch(`${base}/decisions/dec_corruptproof`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        corrupt: boolean;
        proof: unknown;
        proofVerified: boolean;
      };
      assert.equal(body.corrupt, true);
      assert.equal(body.proof, null); // getDecision nulls a corrupt proof
      assert.equal(body.proofVerified, false);
    },
  );
});

test("corrupt stored request/decision JSON → corrupt true, still 200 (no crash)", async () => {
  await withBridge(
    (db) => {
      const id = "dec_corruptdata";
      recordDecision(db, { decisionId: id, request: req, facts: facts(), decision: ALLOW });
      // Corrupt the verbatim JSON blobs directly.
      db.prepare("UPDATE decisions SET request_json = ?, decision_json = ? WHERE decision_id = ?").run(
        "{ broken",
        "{ also broken",
        id,
      );
    },
    async (base) => {
      const res = await fetch(`${base}/decisions/dec_corruptdata`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { corrupt: boolean };
      assert.equal(body.corrupt, true);
    },
  );
});

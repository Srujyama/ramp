/**
 * @ramp/ledger — execution-log.test.ts
 *
 * Exercises {@link recordExecution}: the separate, later append that records what
 * the sandbox executor DID for an already-recorded decision. Verifies read-back
 * via getDecision/listDecisions, idempotency, that a deny (no execution) reads
 * back as `execution: null`, and that a `failed` receipt is preserved as a
 * genuine failure (never a settlement). Run with `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpendRequest, Facts, Decision } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import { recordDecision, recordExecution, getDecision, listDecisions } from "./decision-log.js";

const req: SpendRequest = {
  vendorId: "acme_corp",
  amount: 340,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_exec_0001",
  requestingAgent: "agent_47",
};

function facts(over: Partial<Facts> = {}): Facts {
  return {
    request_id: "inv_exec_0001",
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
  reasons: ["denied: deny/vendor_not_verified"],
  firedRules: ["deny/vendor_not_verified"],
};

function withDb<T>(fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

test("recordExecution: settled receipt reads back on the decision", () => {
  withDb((db) => {
    const { decisionId } = recordDecision(db, { request: req, facts: facts(), decision: ALLOW });
    const { inserted } = recordExecution(db, {
      decisionId,
      receiptId: "rcpt_abc123",
      executionId: "exec_def456",
      status: "settled",
      provider: "sandbox",
    });
    assert.equal(inserted, true);

    const rec = getDecision(db, decisionId);
    assert.ok(rec);
    assert.ok(rec.execution);
    assert.equal(rec.execution.receiptId, "rcpt_abc123");
    assert.equal(rec.execution.executionId, "exec_def456");
    assert.equal(rec.execution.status, "settled");
    assert.equal(rec.execution.provider, "sandbox");
    assert.match(rec.execution.executedAt, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });
});

test("recordExecution: a failed receipt is preserved as failed (never a settlement)", () => {
  withDb((db) => {
    const { decisionId } = recordDecision(db, { request: req, facts: facts(), decision: ALLOW });
    recordExecution(db, {
      decisionId,
      receiptId: "rcpt_fail",
      executionId: "exec_fail",
      status: "failed",
      provider: "sandbox",
    });
    const rec = getDecision(db, decisionId);
    assert.equal(rec?.execution?.status, "failed");
  });
});

test("recordExecution: re-recording the same decision is an idempotent no-op", () => {
  withDb((db) => {
    const { decisionId } = recordDecision(db, { request: req, facts: facts(), decision: ALLOW });
    const first = recordExecution(db, {
      decisionId,
      receiptId: "rcpt_a",
      executionId: "exec_a",
      status: "settled",
      provider: "sandbox",
    });
    const second = recordExecution(db, {
      decisionId,
      receiptId: "rcpt_a",
      executionId: "exec_a",
      status: "settled",
      provider: "sandbox",
    });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false); // append-only: first write wins
    assert.equal(getDecision(db, decisionId)?.execution?.receiptId, "rcpt_a");
  });
});

test("a decision with no execution reads back execution: null (e.g. a deny)", () => {
  withDb((db) => {
    const { decisionId } = recordDecision(db, { request: req, facts: facts(), decision: DENY });
    assert.equal(getDecision(db, decisionId)?.execution, null);
  });
});

test("listDecisions surfaces the execution receipt per row", () => {
  withDb((db) => {
    const { decisionId } = recordDecision(db, { request: req, facts: facts(), decision: ALLOW });
    recordExecution(db, {
      decisionId,
      receiptId: "rcpt_list",
      executionId: "exec_list",
      status: "settled",
      provider: "sandbox",
    });
    const { decisions } = listDecisions(db, {});
    const row = decisions.find((d) => d.decisionId === decisionId);
    assert.equal(row?.execution?.receiptId, "rcpt_list");
  });
});

/**
 * @ramp/ledger — purchase.test.ts (MODULE A)
 *
 * Exercises the fail-closed purchase lifecycle end-to-end with fully INJECTED
 * dependencies (a fake in-memory fact source, a fake policy kernel, and a fake
 * payment executor that records whether it was called). No network, no clock:
 * proof time is pinned via `producedAt` for determinism.
 *
 * The invariants under test are the whole point of the module:
 *   - the executor runs LAST and ONLY for an allowed + persisted + verified decision;
 *   - a DENY never calls the executor;
 *   - a facts/kernel/provenance/proof failure is a policy_error with no execution;
 *   - an audit-write failure or an unverifiable proof is an audit_error with no execution;
 *   - decisionId is deterministic, so retries collapse and same-key/different-content conflicts;
 *   - attestation status is honest ("absent" / "present_unverified", never "verified").
 *
 * Run with `node --test` (Node 24 + node:sqlite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  SpendRequest,
  Facts,
  Decision,
  PolicyKernel,
  AuthoritativeFacts,
} from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import { getDecision } from "./decision-log.js";
import {
  requestPurchase,
  type FactSourcePort,
  type PaymentExecutor,
  type ExecutorRequest,
  type ExecutorReceipt,
} from "./purchase.js";

// --- fixtures ----------------------------------------------------------------

const heroReq: SpendRequest = {
  vendorId: "acme_corp",
  amount: 40,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_2026_07_0043",
  requestingAgent: "agent_47",
};

/** Authoritative facts the fake source returns (never derived from the request). */
function authFacts(over: Partial<AuthoritativeFacts> = {}): AuthoritativeFacts {
  return {
    vendorVerified: true,
    dailyTotalSoFar: 100,
    perTxnCap: 500,
    dailyLimit: 1500,
    approvedCategories: ["office_supplies", "software", "travel"],
    agentClearedCategories: ["office_supplies", "software"],
    attestationPresent: false,
    escalationThreshold: 400,
    vendorRiskTier: "standard",
    budgets: [],
    recentTxnCount: 0,
    velocityLimit: 6,
    ...over,
  };
}

/** A fake, in-memory fact source (no DB reads needed for the lifecycle tests). */
function fakeFactSource(over: Partial<AuthoritativeFacts> = {}): FactSourcePort {
  const facts = authFacts(over);
  return { contextFor: () => facts };
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

/** A fake kernel that returns a fixed decision (or throws / returns garbage). */
function fakeKernel(decision: Decision): PolicyKernel {
  return { evaluate: () => decision };
}

/** A fake payment executor that records whether/how it was called. */
class FakeExecutor implements PaymentExecutor {
  called = false;
  calls: ExecutorRequest[] = [];
  constructor(
    private readonly behavior:
      | { kind: "settle" }
      | { kind: "fail" }
      | { kind: "throw" } = { kind: "settle" },
  ) {}
  execute(req: ExecutorRequest): ExecutorReceipt {
    this.called = true;
    this.calls.push(req);
    if (this.behavior.kind === "throw") {
      throw new Error("simulated executor failure");
    }
    // Deterministic receipt derived from the request (idempotent).
    return {
      receiptId: "rcpt_" + req.decisionId.slice(0, 12),
      executionId: "exec_" + req.decisionId.slice(0, 12),
      status: this.behavior.kind === "fail" ? "failed" : "settled",
      provider: "sandbox",
    };
  }
}

/** Fresh, fully-provisioned in-memory ledger; disposed after `fn`. */
async function withDb<T>(
  fn: (db: ReturnType<typeof openLedger>) => Promise<T> | T,
): Promise<T> {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return await fn(db);
  } finally {
    closeLedger(db);
  }
}

const KERNEL_ID = "ts-reference";
const AT = 1_700_000_000_000; // pinned proof time for determinism

// --- allow path --------------------------------------------------------------

test("ALLOW: allowed request executes and returns a settled receipt", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });

    assert.equal(r.status, "allowed");
    assert.equal(r.outcome, "allow");
    assert.equal(r.executed, true);
    assert.equal(r.proofVerified, true);
    assert.ok(r.decisionId?.startsWith("dec_"));
    assert.ok(r.proofId?.startsWith("proof_"));
    assert.equal(r.receipt?.status, "settled");
    assert.equal(r.receipt?.provider, "sandbox");
    assert.deepEqual(r.firedRules, ["allow/all_conditions_met"]);
    assert.equal(r.requestId, "inv_2026_07_0043");
    // executor was called exactly once, with idempotencyKey === decisionId
    assert.equal(executor.called, true);
    assert.equal(executor.calls.length, 1);
    assert.equal(executor.calls[0]?.idempotencyKey, r.decisionId);
    assert.equal(executor.calls[0]?.decisionId, r.decisionId);
    // message carries no secrets, just a settlement summary
    assert.match(r.message, /settled: 40 USD to acme_corp/);
  });
});

test("ALLOW: the proof is persisted BEFORE execution (durable audit row)", async () => {
  await withDb(async (db) => {
    // An executor that inspects the DB at call time: the decision + proof must
    // already be persisted and verifiable when execute() runs.
    let proofPresentAtExecTime = false;
    const spyExecutor: PaymentExecutor = {
      execute(req: ExecutorRequest): ExecutorReceipt {
        const rec = getDecision(db, req.decisionId);
        proofPresentAtExecTime = rec?.proof != null && rec.status === "allowed";
        return {
          receiptId: "rcpt_x",
          executionId: "exec_x",
          status: "settled",
          provider: "sandbox",
        };
      },
    };
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: spyExecutor,
      producedAt: AT,
    });

    assert.equal(r.status, "allowed");
    assert.equal(proofPresentAtExecTime, true, "proof was persisted before execute()");

    // And the persisted proof independently matches what we returned.
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.proof?.proofId, r.proofId);
  });
});

test("ALLOW: trusted provenance is persisted and folds into the proof", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: new FakeExecutor(),
      toolCallId: "call_123",
      taskId: "task_abc",
      producedAt: AT,
    });
    assert.equal(r.status, "allowed");
    const rec = getDecision(db, r.decisionId!);
    const prov = rec?.proof?.provenance;
    assert.ok(prov, "provenance persisted on the proof");
    // The optional trusted nodes appear ONLY because they were genuinely supplied.
    const nodeIds = prov!.nodes.map((n) => n.id);
    assert.ok(nodeIds.includes("tool_call:call_123"));
    assert.ok(nodeIds.includes("task_chain:task_abc"));
  });
});

test("ALLOW: persisted proof verifies independently (proofVerified true)", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: new FakeExecutor(),
      producedAt: AT,
    });
    assert.equal(r.proofVerified, true);
    assert.equal(r.status, "allowed");
  });
});

// --- deny path ---------------------------------------------------------------

test("DENY: denied request never calls the executor", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(DENY),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource({ vendorVerified: false }),
      db,
      executor,
      producedAt: AT,
    });

    assert.equal(r.status, "denied");
    assert.equal(r.outcome, "deny");
    assert.equal(r.executed, false);
    assert.equal(r.receipt, null);
    assert.equal(r.proofVerified, true); // persisted + verified, just not executed
    assert.deepEqual(r.firedRules, ["deny/vendor_not_verified"]);
    // THE invariant: executor was never touched for a deny.
    assert.equal(executor.called, false);
    // The deny is still durably audited.
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.outcome, "deny");
  });
});

// --- policy_error: facts / kernel / proof construction -----------------------

test("policy_error: invalid spend request is rejected before evaluation", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    const r = await requestPurchase({
      request: { vendorId: "acme_corp" } as unknown as SpendRequest, // malformed
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "policy_error");
    assert.equal(r.decisionId, null);
    assert.equal(r.executed, false);
    assert.equal(executor.called, false);
  });
});

test("policy_error: a fact-source failure prevents execution", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    const failingSource: FactSourcePort = {
      contextFor() {
        throw new Error("db read blew up");
      },
    };
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: failingSource,
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "policy_error");
    assert.equal(r.executed, false);
    assert.equal(executor.called, false);
  });
});

test("policy_error: a kernel throw prevents execution", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    const throwingKernel: PolicyKernel = {
      evaluate() {
        throw new Error("kernel blew up");
      },
    };
    const r = await requestPurchase({
      request: heroReq,
      kernel: throwingKernel,
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "policy_error");
    assert.equal(r.executed, false);
    assert.equal(executor.called, false);
  });
});

test("policy_error: construction failure on a non-finite fact prevents execution (steps 4-6)", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    // Request is well-formed (isSpendRequest passes), but the AUTHORITATIVE facts
    // carry a non-finite number. translateToFacts copies dailyTotalSoFar into
    // facts.daily_total_so_far, which cannot be canonicalized — the id/proof
    // construction (steps 4-6) throws and is caught as a fail-closed policy_error.
    const infiniteSource: FactSourcePort = {
      contextFor: () => authFacts({ dailyTotalSoFar: Number.POSITIVE_INFINITY }),
    };
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: infiniteSource,
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "policy_error");
    assert.equal(r.executed, false);
    assert.equal(executor.called, false);
    assert.equal(r.proofId, null); // proof was never built
    // Nothing was persisted (recordDecision was never reached).
    const rows = db.prepare("SELECT count(*) AS n FROM decisions").get() as {
      n: number;
    };
    assert.equal(rows.n, 0);
  });
});

// --- audit_error: write failure / conflict / unverifiable --------------------

test("audit_error: a recordDecision write failure prevents execution", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor();
    // Force the audit write to fail mid-transaction: remove the fired-rules table
    // so the INSERT throws inside recordDecision (mirrors decision-log's rollback test).
    db.exec("ALTER TABLE decision_fired_rules RENAME TO _gone");
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "audit_error");
    assert.equal(r.executed, false);
    assert.equal(executor.called, false);
    // The proofId is still surfaced for correlation even though nothing persisted.
    assert.ok(r.proofId?.startsWith("proof_"));
  });
});

test("audit_error: a same-key conflicting duplicate is rejected, no execution", async () => {
  await withDb(async (db) => {
    const idempotencyKey = "dec_fixed_key_1";

    // First: an allowed purchase under a fixed idempotency key succeeds + executes.
    const first = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: new FakeExecutor(),
      idempotencyKey,
      producedAt: AT,
    });
    assert.equal(first.status, "allowed");

    // Now re-use the SAME key with DIFFERENT content (different amount → different
    // facts/decision/proof digest) → DecisionConflictError inside recordDecision.
    const executor2 = new FakeExecutor();
    const conflicting = await requestPurchase({
      request: { ...heroReq, amount: 999 },
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: executor2,
      idempotencyKey,
      producedAt: AT,
    });
    assert.equal(conflicting.status, "audit_error");
    assert.equal(conflicting.executed, false);
    assert.equal(executor2.called, false);
    assert.match(conflicting.message, /conflict/i);
  });
});

// --- idempotency -------------------------------------------------------------

test("idempotent: an identical retry collapses to the same decision (ledger no-op)", async () => {
  await withDb(async (db) => {
    const exec1 = new FakeExecutor();
    const first = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: exec1,
      producedAt: AT,
    });
    assert.equal(first.status, "allowed");

    // Re-run the byte-identical request: decisionId is a content hash, so it is
    // stable; recordDecision is an idempotent no-op; the executor's deterministic
    // receipt matches. Both attempts agree.
    const exec2 = new FakeExecutor();
    const second = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: exec2,
      producedAt: AT,
    });
    assert.equal(second.status, "allowed");
    assert.equal(second.decisionId, first.decisionId);
    assert.deepEqual(second.receipt, first.receipt);
    // Exactly one audit row exists for that content.
    const rec = getDecision(db, first.decisionId!);
    assert.ok(rec);
  });
});

// --- executor_error ----------------------------------------------------------

test("executor_error: an executor throw occurs only AFTER an allowed+persisted decision", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor({ kind: "throw" });
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "executor_error");
    assert.equal(r.executed, false);
    assert.equal(executor.called, true); // it WAS called (last step) and threw
    // The decision remains durably persisted despite the executor failure.
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.status, "allowed");
    assert.equal(rec?.proof?.proofId, r.proofId);
  });
});

test("executor_error: a failed receipt maps to executor_error, decision stays persisted", async () => {
  await withDb(async (db) => {
    const executor = new FakeExecutor({ kind: "fail" });
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "executor_error");
    assert.equal(r.executed, false);
    assert.equal(r.receipt?.status, "failed");
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.status, "allowed");
  });
});

// --- optional metadata + honest attestation ----------------------------------

test("missing optional metadata (no invoiceRef/toolCallId/taskId) still works", async () => {
  await withDb(async (db) => {
    const { invoiceRef, ...noInvoice } = heroReq;
    void invoiceRef;
    const executor = new FakeExecutor();
    const r = await requestPurchase({
      request: noInvoice,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor,
      producedAt: AT,
    });
    assert.equal(r.status, "allowed");
    assert.equal(r.executed, true);
    // With no invoiceRef, facts.request_id === "" → requestId falls back to decisionId.
    assert.equal(r.requestId, r.decisionId);
    // No optional trusted nodes were fabricated.
    const prov = getDecision(db, r.decisionId!)?.proof?.provenance;
    const nodeIds = prov!.nodes.map((n) => n.id);
    assert.ok(!nodeIds.some((id) => id.startsWith("tool_call:")));
    assert.ok(!nodeIds.some((id) => id.startsWith("task_chain:")));
  });
});

test("honest attestation: attestation_present false → proof status 'absent'", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource({ attestationPresent: false }),
      db,
      executor: new FakeExecutor(),
      producedAt: AT,
    });
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.proof?.attestationStatus, "absent");
  });
});

test("honest attestation: attestation_present true → 'present_unverified' (never 'verified')", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource({ attestationPresent: true }),
      db,
      executor: new FakeExecutor(),
      producedAt: AT,
    });
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.proof?.attestationStatus, "present_unverified");
    assert.notEqual(rec?.proof?.attestationStatus, "verified");
  });
});

// --- execution receipt is persisted to the audit trail -----------------------

test("ALLOW: the settled receipt is persisted to the ledger (auditable payment)", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: new FakeExecutor({ kind: "settle" }),
      producedAt: AT,
    });
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.execution?.status, "settled");
    assert.equal(rec?.execution?.provider, "sandbox");
    assert.equal(rec?.execution?.receiptId, r.receipt?.receiptId);
    assert.equal(rec?.execution?.executionId, r.receipt?.executionId);
  });
});

test("executor_error (failed receipt): recorded as failed, never as settled", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: new FakeExecutor({ kind: "fail" }),
      producedAt: AT,
    });
    assert.equal(r.status, "executor_error");
    const rec = getDecision(db, r.decisionId!);
    assert.equal(rec?.execution?.status, "failed");
  });
});

test("DENY: nothing executed, so no execution row is written", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: { ...heroReq, vendorId: "sketchy_llc" },
      kernel: fakeKernel(DENY),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource({ vendorVerified: false }),
      db,
      executor: new FakeExecutor(),
      producedAt: AT,
    });
    assert.equal(r.status, "denied");
    assert.equal(getDecision(db, r.decisionId!)?.execution, null);
  });
});

test("executor throw: decision persisted, no execution row (nothing settled)", async () => {
  await withDb(async (db) => {
    const r = await requestPurchase({
      request: heroReq,
      kernel: fakeKernel(ALLOW),
      kernelId: KERNEL_ID,
      factSource: fakeFactSource(),
      db,
      executor: new FakeExecutor({ kind: "throw" }),
      producedAt: AT,
    });
    assert.equal(r.status, "executor_error");
    // The executor threw before returning a receipt → nothing to record.
    assert.equal(getDecision(db, r.decisionId!)?.execution, null);
  });
});

/**
 * @ramp/ledger — approval.test.ts
 *
 * Escalation is theatre unless the agent cannot approve itself and the approval
 * binds to the exact facts. Both are attacked here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision, Facts, SpendRequest } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import type { LedgerDb } from "./db.js";
import { recordDecision } from "./decision-log.js";
import {
  resolveEscalation,
  approvalFor,
  isApprovedForPayment,
  listPendingEscalations,
  ApprovalError,
} from "./approval.js";

const REQ: SpendRequest = {
  vendorId: "acme_corp",
  amount: 450,
  currency: "USD",
  category: "office_supplies",
  invoiceRef: "inv_esc",
  requestingAgent: "agent_47",
};

const FACTS: Facts = {
  request_id: "inv_esc",
  requesting_agent: "agent_47",
  amount: 450,
  vendor: "acme_corp",
  category: "office_supplies",
  vendor_verified: true,
  daily_total_so_far: 0,
  per_txn_cap: 500,
  daily_limit: 1500,
  approved_categories: ["office_supplies"],
  agent_cleared_categories: ["office_supplies"],
  attestation_present: true,
  escalation_threshold: 400,
  vendor_risk_tier: "standard",
};

const ESCALATE: Decision = {
  decision: "escalate",
  reasons: ["over_escalation_threshold: amount 450 > escalation_threshold 400"],
  firedRules: ["escalate/over_escalation_threshold"],
};

const ALLOW: Decision = {
  decision: "allow",
  reasons: ["all_conditions_met"],
  firedRules: ["allow/all_conditions_met"],
};

function withDb<T>(fn: (db: LedgerDb) => T): T {
  const db = openLedger(IN_MEMORY_PATH, { provisionIfEmpty: true, seed: true });
  try {
    return fn(db);
  } finally {
    closeLedger(db);
  }
}

/** Record one escalated decision and return its id. */
function seedEscalation(db: LedgerDb, id = "esc_1"): string {
  recordDecision(db, { decisionId: id, request: REQ, facts: FACTS, decision: ESCALATE });
  return id;
}

// ---------------------------------------------------------------------------
// THE CRUX: the agent cannot approve itself.
// ---------------------------------------------------------------------------

test("THE CRUX: the requesting agent cannot approve its own escalation", () => {
  // If this ever passes, escalation is a speed bump with a paper trail that lies
  // about having had a human in it — strictly worse than no escalation at all,
  // because it manufactures evidence of a control that does not exist.
  withDb((db) => {
    const id = seedEscalation(db);
    assert.throws(
      () => resolveEscalation(db, { decisionId: id, verdict: "approved", approvedBy: "agent_47" }),
      (err: unknown) =>
        err instanceof ApprovalError && err.code === "self_approval",
      "the agent that requested the payment must never be able to grant it",
    );
    // ...and it stays unpayable.
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("a different human CAN approve it", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    const rec = resolveEscalation(db, {
      decisionId: id,
      verdict: "approved",
      approvedBy: "alice",
      resolvedAt: "2026-07-15T12:00:00Z",
    });
    assert.equal(rec.verdict, "approved");
    assert.equal(rec.approvedBy, "alice");
    assert.equal(isApprovedForPayment(db, id), true);
  });
});

// ---------------------------------------------------------------------------
// THE BINDING: an approval is worth nothing for different facts.
// ---------------------------------------------------------------------------

test("THE BINDING: an approval is void once the facts change", () => {
  // The attack it stops: get a $1 escalation approved, then present the approval
  // against a $50,000 payment. The approval carries the digest it was granted
  // against; if the decision's facts move, whatever the human said yes to, it was
  // not this.
  withDb((db) => {
    const id = seedEscalation(db);
    resolveEscalation(db, { decisionId: id, verdict: "approved", approvedBy: "alice" });
    assert.equal(isApprovedForPayment(db, id), true);

    // Someone rewrites the decision's content under the approval.
    db.exec(`UPDATE decisions SET content_digest = 'sha256:swapped' WHERE decision_id = '${id}'`);

    assert.equal(
      approvalFor(db, id),
      null,
      "an approval granted against other facts must not be returned at all",
    );
    assert.equal(
      isApprovedForPayment(db, id),
      false,
      "and the payment must not be payable on it",
    );
  });
});

test("the approval binds to the digest from the ROW, not from the caller", () => {
  // A caller-supplied digest would let an approver claim to have approved facts
  // they never saw.
  withDb((db) => {
    const id = seedEscalation(db);
    const stored = db
      .prepare("SELECT content_digest AS d FROM decisions WHERE decision_id = ?")
      .get(id) as { d: string };
    const rec = resolveEscalation(db, {
      decisionId: id,
      verdict: "approved",
      approvedBy: "alice",
    });
    assert.equal(rec.factsDigest, stored.d);
  });
});

// ---------------------------------------------------------------------------
// You can only resolve what is actually being held.
// ---------------------------------------------------------------------------

test("a DENY cannot be approved — the lattice holds here too", () => {
  // The loudest possible failure would be a human overriding a deny. `deny`
  // dominates in the kernel; if a human could approve one, that ordering would be
  // decorative and every deny rule would be negotiable.
  withDb((db) => {
    recordDecision(db, {
      decisionId: "denied_1",
      request: { ...REQ, vendorId: "sketchy_llc" },
      facts: { ...FACTS, vendor: "sketchy_llc", vendor_verified: false },
      decision: {
        decision: "deny",
        reasons: ["vendor_not_verified"],
        firedRules: ["deny/vendor_not_verified"],
      },
    });
    assert.throws(
      () =>
        resolveEscalation(db, {
          decisionId: "denied_1",
          verdict: "approved",
          approvedBy: "alice",
        }),
      (err: unknown) => err instanceof ApprovalError && err.code === "not_escalated",
    );
  });
});

test("an ALLOW cannot be approved — there is nothing being held", () => {
  withDb((db) => {
    recordDecision(db, {
      decisionId: "allowed_1",
      request: REQ,
      facts: FACTS,
      decision: ALLOW,
    });
    assert.throws(
      () =>
        resolveEscalation(db, {
          decisionId: "allowed_1",
          verdict: "approved",
          approvedBy: "alice",
        }),
      (err: unknown) => err instanceof ApprovalError && err.code === "not_escalated",
    );
  });
});

test("an unknown decision cannot be approved", () => {
  withDb((db) => {
    assert.throws(
      () => resolveEscalation(db, { decisionId: "nope", verdict: "approved", approvedBy: "alice" }),
      (err: unknown) => err instanceof ApprovalError && err.code === "not_found",
    );
  });
});

test("approvals are append-only — a decision resolves exactly once", () => {
  // A changed mind is a NEW decision, not a rewritten approval. Otherwise the
  // approval trail is editable, and an editable approval trail records whatever
  // the last writer wanted it to say.
  withDb((db) => {
    const id = seedEscalation(db);
    resolveEscalation(db, { decisionId: id, verdict: "rejected", approvedBy: "alice" });
    assert.throws(
      () => resolveEscalation(db, { decisionId: id, verdict: "approved", approvedBy: "bob" }),
      (err: unknown) => err instanceof ApprovalError && err.code === "already_resolved",
      "a rejection must not be quietly upgraded to an approval",
    );
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

// ---------------------------------------------------------------------------
// Default posture.
// ---------------------------------------------------------------------------

test("an unresolved escalation is NOT payable — silence is not consent", () => {
  // Stated positively on purpose. A `!rejected` check would treat "nobody has
  // looked at it yet" as permission, which is the exact failure escalation
  // exists to prevent.
  withDb((db) => {
    const id = seedEscalation(db);
    assert.equal(approvalFor(db, id), null);
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("a REJECTED escalation is not payable", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    resolveEscalation(db, { decisionId: id, verdict: "rejected", approvedBy: "alice" });
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("listPendingEscalations shows only what still needs a human", () => {
  withDb((db) => {
    seedEscalation(db, "esc_a");
    seedEscalation(db, "esc_b");
    assert.equal(listPendingEscalations(db).length, 2);

    resolveEscalation(db, { decisionId: "esc_a", verdict: "approved", approvedBy: "alice" });
    const pending = listPendingEscalations(db);
    assert.equal(pending.length, 1, "a resolved escalation leaves the queue");
    assert.equal(pending[0]?.decisionId, "esc_b");
  });
});

test("escalations are chained like any other decision", () => {
  // A held payment is a real event. If it were not chained, deleting the
  // escalation you did not want reviewed would be invisible.
  withDb((db) => {
    seedEscalation(db, "esc_x");
    const row = db
      .prepare("SELECT seq, chain_hash AS h FROM decisions WHERE decision_id = 'esc_x'")
      .get() as { seq: number; h: string };
    assert.ok(row.seq >= 1);
    assert.ok(row.h && row.h.length > 0);
  });
});

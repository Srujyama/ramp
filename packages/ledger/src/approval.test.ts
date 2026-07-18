/**
 * @ramp/ledger — approval.test.ts
 *
 * Escalation is theatre unless the agent cannot approve itself and the approval
 * binds to the exact facts. Both are attacked here.
 */
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import type { Decision, Facts, SpendRequest } from "@ramp/shared";
import { openLedger, closeLedger, IN_MEMORY_PATH } from "./db.js";
import type { LedgerDb } from "./db.js";
import { recordDecision } from "./decision-log.js";
import {
  signApproval,
  demoApproverKeyring,
  demoApproverPrivateKey,
  type ApprovalStatement,
} from "./approver.js";
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
  agent_identity_verified: true,
  escalation_threshold: 400,
  vendor_risk_tier: "standard",
budgets: [],
recent_txn_count: 0,
velocity_limit: 6,
duplicate_recent_count: 0,
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

const KEYRING = demoApproverKeyring();

/** The decision's current content digest — what an approver must sign for. */
function digestOf(db: LedgerDb, decisionId: string): string {
  const row = db
    .prepare("SELECT content_digest AS d FROM decisions WHERE decision_id = ?")
    .get(decisionId) as { d: string } | undefined;
  return row?.d ?? "unknown";
}

/** Sign an approval as a registered approver. Identity comes from the KEY. */
function signed(
  db: LedgerDb,
  decisionId: string,
  verdict: "approved" | "rejected",
  keyId = "approver_alice",
  over: Partial<ApprovalStatement> = {},
) {
  const statement: ApprovalStatement = {
    schema: "ramp/approval-v1",
    decisionId,
    verdict,
    factsDigest: digestOf(db, decisionId),
    note: null,
    at: "2026-07-16T12:00:00Z",
    ...over,
  };
  return signApproval(statement, demoApproverPrivateKey(keyId), keyId);
}

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
// THE CRUX: identity is PROVEN, not typed.
// ---------------------------------------------------------------------------

test("THE CRUX: you cannot approve by CLAIMING to be alice — you need her key", () => {
  // The gap this closes. `approvedBy: "alice"` used to be a string parameter, so
  // anyone who could run the CLI could type it and the ledger recorded "alice"
  // forever, with nothing able to tell it wasn't her. There is now no parameter
  // to lie in: identity is derived from whichever registered key verifies.
  withDb((db) => {
    const id = seedEscalation(db);
    const attacker = generateKeyPairSync("ed25519");

    // A mathematically perfect signature, from a key nobody registered.
    const forged = signApproval(
      {
        schema: "ramp/approval-v1",
        decisionId: id,
        verdict: "approved",
        factsDigest: digestOf(db, id),
        note: "totally alice, honest",
        at: "2026-07-16T12:00:00Z",
      },
      attacker.privateKey,
      "approver_alice", // claiming alice's key id changes nothing
    );

    assert.throws(
      () => resolveEscalation(db, { approval: forged, keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "unauthenticated",
      "claiming a key id you do not hold must not authenticate you",
    );
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("identity comes from the KEYRING, not from anything the signer wrote", () => {
  // Even a validly-signed approval cannot rename its signer: bob signs, and the
  // record says bob, no matter what the statement or the caller would prefer.
  withDb((db) => {
    const id = seedEscalation(db);
    const rec = resolveEscalation(db, {
      approval: signed(db, id, "approved", "approver_bob"),
      keyring: KEYRING,
    });
    assert.equal(rec.approvedBy, "bob", "the record names whoever's key verified");
  });
});

test("an unregistered approver is rejected however valid the signature", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    const outsider = generateKeyPairSync("ed25519");
    const approval = signApproval(
      {
        schema: "ramp/approval-v1",
        decisionId: id,
        verdict: "approved",
        factsDigest: digestOf(db, id),
        note: null,
        at: "2026-07-16T12:00:00Z",
      },
      outsider.privateKey,
      "approver_mallory",
    );
    assert.throws(
      () => resolveEscalation(db, { approval, keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "unauthenticated",
    );
  });
});

test("an empty keyring approves nothing (fail-closed)", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    assert.throws(
      () => resolveEscalation(db, { approval: signed(db, id, "approved"), keyring: new Map() }),
      (err: unknown) => err instanceof ApprovalError && err.code === "unauthenticated",
    );
  });
});

test("tampering with a signed statement breaks it", () => {
  // Flip a rejection into an approval under a real signature.
  withDb((db) => {
    const id = seedEscalation(db);
    const real = signed(db, id, "rejected");
    const tampered = { ...real, statement: { ...real.statement, verdict: "approved" as const } };
    assert.throws(
      () => resolveEscalation(db, { approval: tampered, keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "unauthenticated",
    );
  });
});

test("a registered approver CAN approve", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    const rec = resolveEscalation(db, { approval: signed(db, id, "approved"), keyring: KEYRING });
    assert.equal(rec.verdict, "approved");
    assert.equal(rec.approvedBy, "alice");
    assert.equal(isApprovedForPayment(db, id), true);
  });
});

test("THE CRUX (still): the requesting agent cannot approve its own escalation", () => {
  // Two independent guards now. The primary one is that an agent holds no
  // approver key at all — it cannot produce a verifiable approval. This asserts
  // the backstop for the day an operator account shares a name with an agent id.
  withDb((db) => {
    recordDecision(db, {
      decisionId: "esc_self",
      request: { ...REQ, requestingAgent: "alice" },
      facts: { ...FACTS, requesting_agent: "alice" },
      decision: ESCALATE,
    });
    assert.throws(
      () => resolveEscalation(db, { approval: signed(db, "esc_self", "approved"), keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "self_approval",
      "an approver must never resolve an escalation they themselves requested",
    );
  });
});

// ---------------------------------------------------------------------------
// THE BINDING: an approval is worth nothing for different facts.
// ---------------------------------------------------------------------------

test("THE BINDING: an approval signed for other facts is refused", () => {
  // The $1-approval-for-$50,000 attack, now wearing a valid signature. The digest
  // is INSIDE the signature, so the approver signed for specific facts — present
  // it against any others and it is refused rather than silently bound.
  withDb((db) => {
    const id = seedEscalation(db);
    const stale = signed(db, id, "approved", "approver_alice", {
      factsDigest: "sha256:some_other_decision",
    });
    assert.throws(
      () => resolveEscalation(db, { approval: stale, keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "stale_approval",
    );
  });
});

test("THE BINDING: an approval is void once the facts change", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    resolveEscalation(db, { approval: signed(db, id, "approved"), keyring: KEYRING });
    assert.equal(isApprovedForPayment(db, id), true);

    db.exec(`UPDATE decisions SET content_digest = 'sha256:swapped' WHERE decision_id = '${id}'`);

    assert.equal(approvalFor(db, id), null, "an approval for other facts must not be returned");
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

// ---------------------------------------------------------------------------
// You can only resolve what is actually being held.
// ---------------------------------------------------------------------------

test("a DENY cannot be approved — the lattice holds here too", () => {
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
      () => resolveEscalation(db, { approval: signed(db, "denied_1", "approved"), keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "not_escalated",
    );
  });
});

test("an ALLOW cannot be approved — there is nothing being held", () => {
  withDb((db) => {
    recordDecision(db, { decisionId: "allowed_1", request: REQ, facts: FACTS, decision: ALLOW });
    assert.throws(
      () => resolveEscalation(db, { approval: signed(db, "allowed_1", "approved"), keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "not_escalated",
    );
  });
});

test("an unknown decision cannot be approved", () => {
  withDb((db) => {
    const approval = signApproval(
      {
        schema: "ramp/approval-v1",
        decisionId: "nope",
        verdict: "approved",
        factsDigest: "x",
        note: null,
        at: "2026-07-16T12:00:00Z",
      },
      demoApproverPrivateKey("approver_alice"),
      "approver_alice",
    );
    assert.throws(
      () => resolveEscalation(db, { approval, keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "not_found",
    );
  });
});

test("approvals are append-only — a decision resolves exactly once", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    resolveEscalation(db, { approval: signed(db, id, "rejected"), keyring: KEYRING });
    assert.throws(
      () => resolveEscalation(db, { approval: signed(db, id, "approved", "approver_bob"), keyring: KEYRING }),
      (err: unknown) => err instanceof ApprovalError && err.code === "already_resolved",
      "a rejection must not be quietly upgraded to an approval, even by someone else",
    );
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

// ---------------------------------------------------------------------------
// Default posture.
// ---------------------------------------------------------------------------

test("an unresolved escalation is NOT payable — silence is not consent", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    assert.equal(approvalFor(db, id), null);
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("a REJECTED escalation is not payable", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    resolveEscalation(db, { approval: signed(db, id, "rejected"), keyring: KEYRING });
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("resolveEscalation is TOTAL on hostile approvals — a verdict, never a crash", () => {
  withDb((db) => {
    const id = seedEscalation(db);
    for (const hostile of [undefined, null, "", 42, [], {}, { statement: null }, Object.create(null)]) {
      assert.throws(
        () => resolveEscalation(db, { approval: hostile, keyring: KEYRING }),
        (err: unknown) => err instanceof ApprovalError && err.code === "unauthenticated",
      );
    }
    assert.equal(isApprovedForPayment(db, id), false);
  });
});

test("listPendingEscalations shows only what still needs a human", () => {
  withDb((db) => {
    seedEscalation(db, "esc_a");
    seedEscalation(db, "esc_b");
    assert.equal(listPendingEscalations(db).length, 2);
    resolveEscalation(db, { approval: signed(db, "esc_a", "approved"), keyring: KEYRING });
    const pending = listPendingEscalations(db);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.decisionId, "esc_b");
  });
});

test("escalations are chained like any other decision", () => {
  withDb((db) => {
    seedEscalation(db, "esc_x");
    const row = db
      .prepare("SELECT seq, chain_hash AS h FROM decisions WHERE decision_id = 'esc_x'")
      .get() as { seq: number; h: string };
    assert.ok(row.seq >= 1);
    assert.ok(row.h && row.h.length > 0);
  });
});

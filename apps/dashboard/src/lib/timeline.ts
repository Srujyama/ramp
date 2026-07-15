/**
 * @ramp/dashboard — execution timeline (pure, tested)
 *
 * Collapses one evaluated spend request into the six-stage lifecycle an auditor
 * reads top-to-bottom:
 *
 *   Agent request → Trusted facts loaded → Policy evaluated → Decision recorded
 *   → Proof validated → Payment executed / blocked / failed
 *
 * Every stage's `state` and `detail` are derived ONLY from what the audit trail
 * actually records — never overstated. The states deliberately keep four failure
 * shapes separable: a policy DENIAL (payment `blocked`) is not a payment FAILURE
 * (`failed`), a proof MISMATCH (`failed`) is not a malformed CORRUPT proof, and a
 * gate-only allow that was never executed reads as `skipped`, never as settled.
 *
 * This is the single source of truth for the DecisionDetail stepper; the page is
 * a thin renderer over `buildTimeline`.
 */
import type { DecisionView } from "./types.js";
import { formatMoney, ruleTitle } from "./format.js";

export type StageState =
  | "done"
  | "blocked"
  | "failed"
  | "corrupt"
  | "skipped"
  | "pending";

export interface TimelineStage {
  key: string;
  title: string;
  state: StageState;
  /** Deterministic human explanation of THIS stage's state. */
  detail: string;
  /** An id/timestamp/digest to surface when available. */
  meta?: string;
}

function amountString(v: DecisionView): string {
  const currency = v.request?.currency ?? "USD";
  return formatMoney(v.amount, currency);
}

/** 1. Agent request — the untrusted input that started everything. */
function requestStage(v: DecisionView): TimelineStage {
  return {
    key: "request",
    title: "Agent request",
    state: "done",
    detail: `${v.agentId} requested ${amountString(v)} to ${v.vendorId} for ${v.category}.`,
    meta: v.requestId,
  };
}

/** 2. Trusted facts loaded — authoritative facts, never model narration. */
function factsStage(v: DecisionView): TimelineStage {
  if (v.facts) {
    return {
      key: "facts",
      title: "Trusted facts loaded",
      state: "done",
      detail:
        "Facts came from authoritative sources (ledger DB + vendor registry), never model narration.",
    };
  }
  return {
    key: "facts",
    title: "Trusted facts loaded",
    state: "skipped",
    detail: "No trusted facts were recorded for this row.",
  };
}

/** 3. Policy evaluated — the deterministic kernel's verdict + fired rules. */
function policyStage(v: DecisionView): TimelineStage {
  const policyDigest = v.proof?.policyDigest ?? undefined;
  if (!v.decision && !v.outcome) {
    return {
      key: "policy",
      title: "Policy evaluated",
      state: "skipped",
      detail: "Policy was not evaluated — this row recorded an error, not a decision.",
      meta: policyDigest,
    };
  }
  const verdict =
    v.outcome === "allow"
      ? "Allowed"
      : v.outcome === "deny"
        ? "Denied"
        : v.outcome === "escalate"
          ? "Held for approval"
          : "Evaluated";
  const rules =
    v.firedRules.length > 0
      ? v.firedRules.map((r) => ruleTitle(r)).join(", ")
      : "no rules fired";
  return {
    key: "policy",
    title: "Policy evaluated",
    state: "done",
    detail: `${verdict} — ${rules}.`,
    meta: policyDigest,
  };
}

/** 4. Decision recorded — persisted to the append-only ledger (or an error). */
function decisionStage(v: DecisionView): TimelineStage {
  if (v.status === "error") {
    return {
      key: "decision",
      title: "Decision recorded",
      state: "failed",
      detail: "Infrastructure or validation error — no policy decision was recorded.",
      meta: v.decisionId || undefined,
    };
  }
  if (!v.decisionId) {
    return {
      key: "decision",
      title: "Decision recorded",
      state: "pending",
      detail: "No decision id was recorded for this row.",
    };
  }
  return {
    key: "decision",
    title: "Decision recorded",
    state: "done",
    detail: v.corrupt
      ? "Written to the append-only ledger, but a stored blob failed to parse — treat fields as suspect."
      : "Written to the append-only audit ledger.",
    meta: v.decisionId,
  };
}

/** 5. Proof validated — independently recomputed on every read. */
function proofStage(v: DecisionView): TimelineStage {
  const proofId = v.proof?.proofId ?? undefined;
  const base = { key: "proof", title: "Proof validated" as const };
  switch (v.proofVerification.reason) {
    case "ok":
      return {
        ...base,
        state: "done",
        detail: "Proof valid — independently recomputed and matches.",
        meta: proofId,
      };
    case "mismatch":
      return {
        ...base,
        state: "failed",
        detail: "Tampered — recomputes to a different id.",
        meta: proofId,
      };
    case "corrupt":
      return {
        ...base,
        state: "corrupt",
        detail: "Stored proof is malformed.",
        meta: proofId,
      };
    case "absent":
      return {
        ...base,
        state: "skipped",
        detail: "No proof stored.",
        meta: proofId,
      };
  }
}

/**
 * 6. Payment executed / blocked / failed — derived like `paymentChip`, keeping
 * a policy DENIAL (`blocked`) separable from an executor FAILURE (`failed`) and
 * from a gate-only allow that was never executed (`skipped`).
 */
function paymentStage(v: DecisionView): TimelineStage {
  const receiptId = v.execution?.receiptId ?? undefined;
  if (v.execution) {
    if (v.execution.status === "settled") {
      return {
        key: "payment",
        title: "Payment executed",
        state: "done",
        detail: "Sandbox payment settled — no real money moves.",
        meta: receiptId,
      };
    }
    return {
      key: "payment",
      title: "Payment failed",
      state: "failed",
      detail: "Payment executor failed — no settlement.",
      meta: receiptId,
    };
  }
  if (v.outcome === "deny") {
    return {
      key: "payment",
      title: "Payment blocked",
      state: "blocked",
      detail: "Denied by policy — executor never called.",
    };
  }
  if (v.outcome === "escalate") {
    return {
      key: "payment",
      title: "Payment held",
      state: "pending",
      detail:
        "Policy escalated this to a human — executor never called. Held, awaiting approval.",
    };
  }
  if (v.outcome === "allow") {
    return {
      key: "payment",
      title: "Payment not executed",
      state: "skipped",
      detail: "Allowed, but no sandbox execution recorded (gate-only policy check).",
    };
  }
  return {
    key: "payment",
    title: "Payment not executed",
    state: "skipped",
    detail: "No payment applies to this row.",
  };
}

/** The six-stage execution lifecycle, in order. */
export function buildTimeline(v: DecisionView): TimelineStage[] {
  return [
    requestStage(v),
    factsStage(v),
    policyStage(v),
    decisionStage(v),
    proofStage(v),
    paymentStage(v),
  ];
}

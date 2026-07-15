/**
 * @ramp/dashboard — presentation helpers
 *
 * Pure formatting + honest status derivation. The rules here NEVER invent data:
 * payment status is derived only from what the audit trail actually records
 * (the execution receipt + the policy outcome), so a gate-only allow that was
 * never executed reads as "not executed", not "settled".
 */
import type {
  DecisionOutcome,
  DecisionView,
  ProofVerificationReason,
  RuleId,
} from "./types.js";

export type Tone = "accent" | "deny" | "warn" | "info" | "neutral";

/** Money is stored as whole currency units (no cents). Show it honestly. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

/** SQLite datetime ("2026-07-14 10:00:00", UTC) → localized absolute string. */
export function formatTimestamp(ts: string): string {
  const d = new Date(ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

/** Short "2 min ago" style for dense table cells. Absolute stays the tooltip. */
export function formatRelative(ts: string, now: Date): string {
  const d = new Date(ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  const secs = Math.round((now.getTime() - d.getTime()) / 1000);
  if (secs <= 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Human-readable metadata for each policy rule id (blurbs, not raw slugs). */
export const RULE_META: Record<RuleId, { title: string; blurb: string }> = {
  "allow/all_conditions_met": {
    title: "All conditions met",
    blurb: "Every policy condition held — an allow backed by a verifiable proof.",
  },
  "deny/vendor_not_verified": {
    title: "Vendor not verified",
    blurb: "The vendor is absent or unverified in the registry.",
  },
  "deny/over_per_txn_cap": {
    title: "Over per-transaction cap",
    blurb: "The amount exceeds the per-transaction cap.",
  },
  "deny/agent_uncleared_for_category": {
    title: "Agent not cleared",
    blurb: "The agent isn't cleared to spend in this category.",
  },
  "deny/category_not_approved": {
    title: "Category not approved",
    blurb: "The category isn't on the org's approved list.",
  },
  "deny/daily_limit_exceeded": {
    title: "Daily limit exceeded",
    blurb: "This spend would push today's total over the daily limit.",
  },
  "deny/attestation_invalid": {
    title: "Attestation invalid",
    blurb:
      "No verified attestation ties this invoice to the vendor's registered domain. " +
      "Missing, expired, forged, and “signed by the wrong domain” all land here.",
  },
  "deny/malformed_facts": {
    title: "Malformed facts",
    blurb:
      "A numeric fact wasn't a finite, non-negative integer, so the request was " +
      "refused without being evaluated. Infrastructure, not policy — you should " +
      "never see this from a well-formed request.",
  },
};

export function ruleTitle(id: RuleId): string {
  return RULE_META[id]?.title ?? id;
}
export function ruleBlurb(id: RuleId): string {
  return RULE_META[id]?.blurb ?? id;
}

// --- status derivation (honest) ----------------------------------------------

export interface StatusChip {
  label: string;
  tone: Tone;
  /** Longer explanation for a title/tooltip and the detail view. */
  title: string;
}

/** The policy outcome chip (allow / deny / error). */
export function outcomeChip(v: DecisionView): StatusChip {
  if (v.status === "error") {
    return { label: "Error", tone: "warn", title: "An infrastructure/validation error was recorded — not a policy decision." };
  }
  if (v.outcome === "allow") {
    return { label: "Allowed", tone: "accent", title: "Policy allowed this spend — every condition held." };
  }
  return { label: "Denied", tone: "deny", title: "Policy denied this spend." };
}

/** The independent proof-verification chip (4-valued). */
export function verificationChip(reason: ProofVerificationReason): StatusChip {
  switch (reason) {
    case "ok":
      return { label: "Proof valid", tone: "accent", title: "The stored proof was independently recomputed and matches the recorded decision — the record is untampered." };
    case "mismatch":
      return { label: "Tampered", tone: "deny", title: "The proof recomputes to a different id — the record was altered." };
    case "corrupt":
      return { label: "Corrupt", tone: "deny", title: "The stored proof is malformed and could not be verified." };
    case "absent":
      return { label: "No proof", tone: "neutral", title: "No tamper-evident proof was stored for this decision." };
  }
}

/**
 * The payment chip, derived ONLY from recorded facts. A settled receipt reads as
 * settled; a failed receipt as failed; a deny as blocked; an allow with no
 * recorded execution (e.g. a gate-only policy check) as "not executed" — never as
 * a settlement it can't prove.
 */
export function paymentChip(v: DecisionView): StatusChip {
  if (v.execution) {
    if (v.execution.status === "settled") {
      return { label: "Settled (sandbox)", tone: "accent", title: `Sandbox payment settled (${v.execution.provider}) — receipt ${v.execution.receiptId}. No real money moves.` };
    }
    return { label: "Payment failed", tone: "deny", title: `The sandbox executor returned a failed receipt (${v.execution.provider}). No settlement occurred.` };
  }
  if (v.outcome === "deny") {
    return { label: "Blocked", tone: "neutral", title: "Denied by policy — the executor was never called, so no payment was attempted." };
  }
  if (v.outcome === "allow") {
    return { label: "Not executed", tone: "neutral", title: "Allowed by policy, but no sandbox execution was recorded for this row (e.g. a gate-only policy check)." };
  }
  return { label: "—", tone: "neutral", title: "No payment applies to this row." };
}

// --- deterministic human-readable explanations -------------------------------
//
// Pure functions derived ONLY from decision state — no LLM, no I/O. The same
// deny-reason phrase map + join back both explainDecision and explainSimulation
// so the two narratives stay consistent.

/**
 * One plain-language phrase per rule id. Deny phrases slot into
 * "Denied because <phrase>"; the allow phrase narrates a clean pass. Exhaustive
 * over RuleId so every fired rule can always be put into words.
 */
const RULE_PHRASE: Record<RuleId, string> = {
  "allow/all_conditions_met": "every policy condition held",
  "deny/vendor_not_verified": "the vendor is not in the approved registry",
  "deny/over_per_txn_cap": "the amount exceeds the per-transaction cap",
  "deny/agent_uncleared_for_category": "the agent is not cleared for this category",
  "deny/category_not_approved": "the category is not on the approved list",
  "deny/daily_limit_exceeded": "it would exceed the daily limit",
  "deny/attestation_invalid":
    "no verified attestation ties this invoice to the vendor's registered domain",
  "deny/malformed_facts": "the request's numbers were not usable, so it was not evaluated",
};

/** Oxford-comma join: [] → "", [a] → "a", [a,b] → "a and b", [a,b,c] → "a, b, and c". */
function humanJoin(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] as string;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The deterministic "because …" clause for the fired deny rules, in
 * rule-evaluation order. Non-deny rules are ignored; if no deny rule is present
 * we still return an honest, generic clause rather than an empty string.
 */
function denyReasonClause(firedRules: RuleId[]): string {
  const phrases = firedRules
    .filter((r) => r.startsWith("deny/"))
    .map((r) => RULE_PHRASE[r]);
  if (phrases.length === 0) return "the policy conditions were not met";
  return humanJoin(phrases);
}

/**
 * A concise, plain-English account of a recorded decision, derived purely from
 * its state. Precedence (first match wins): proof-integrity failure dominates
 * because a broken proof means the record itself can't be trusted, then
 * record-level corruption, then a pre-decision error, then deny, then allow
 * (narrated by what execution actually recorded).
 */
export function explainDecision(v: DecisionView): string {
  // 1. Proof integrity problem first — overrides the outcome narrative.
  if (v.proofVerification.reason === "mismatch") {
    return "The stored proof no longer matches the recorded decision. No payment was executed.";
  }
  if (v.proofVerification.reason === "corrupt") {
    return "The stored proof is malformed and could not be verified. Treat this record as compromised.";
  }
  // 2. Record-level corruption (if not already surfaced via the proof).
  if (v.corrupt === true) {
    return "This record is corrupt and cannot be trusted.";
  }
  // 3. An error was recorded before any policy decision was reached.
  if (v.status === "error") {
    return "An error occurred before a policy decision was reached. No payment was executed.";
  }
  // 4. Policy denied the spend.
  if (v.outcome === "deny") {
    return `Denied because ${denyReasonClause(v.firedRules)}. No payment was executed.`;
  }
  // 5. Policy allowed the spend — narrate by what execution actually recorded.
  if (v.outcome === "allow") {
    if (v.execution?.status === "settled") {
      return "Allowed because the vendor is verified, the category is allowed, and the amount is within policy limits. The sandbox payment settled.";
    }
    if (v.execution?.status === "failed") {
      return "Policy allowed the purchase, but the payment executor failed. No settlement occurred.";
    }
    return "Allowed by policy — every condition held. No sandbox payment was executed for this record.";
  }
  // Fallback: no outcome and not covered above — should not occur for real rows.
  return "No policy decision was recorded for this request.";
}

/**
 * The plain-English account of a hypothetical (simulated) evaluation. Shares the
 * deny-reason clause with explainDecision so simulation and history read alike.
 */
export function explainSimulation(
  outcome: DecisionOutcome,
  firedRules: RuleId[],
): string {
  if (outcome === "allow") {
    return "Allowed — every policy condition held: the vendor is verified, the category is approved and the agent is cleared, and the amount is within the per-transaction cap and daily limit.";
  }
  return `Denied because ${denyReasonClause(firedRules)}. No payment would be executed.`;
}

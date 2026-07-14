/**
 * @ramp/dashboard — presentation helpers
 *
 * Pure formatting + honest status derivation. The rules here NEVER invent data:
 * payment status is derived only from what the audit trail actually records
 * (the execution receipt + the policy outcome), so a gate-only allow that was
 * never executed reads as "not executed", not "settled".
 */
import type {
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
    blurb: "Every policy condition held — a proven allow.",
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
      return { label: "Verified", tone: "accent", title: "The proof was independently recomputed and matches — the record is untampered." };
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
 * recorded execution (e.g. a gate-only hook check) as "not executed" — never as
 * a settlement it can't prove.
 */
export function paymentChip(v: DecisionView): StatusChip {
  if (v.execution) {
    if (v.execution.status === "settled") {
      return { label: "Settled", tone: "accent", title: `Sandbox payment settled (${v.execution.provider}) — receipt ${v.execution.receiptId}. No real money moves.` };
    }
    return { label: "Payment failed", tone: "deny", title: `The sandbox executor returned a failed receipt (${v.execution.provider}). No settlement occurred.` };
  }
  if (v.outcome === "deny") {
    return { label: "Blocked", tone: "neutral", title: "Denied by policy — the executor was never called, so no payment was attempted." };
  }
  if (v.outcome === "allow") {
    return { label: "Not executed", tone: "neutral", title: "Allowed by policy, but no sandbox execution was recorded for this row (e.g. a gate-only hook check)." };
  }
  return { label: "—", tone: "neutral", title: "No payment applies to this row." };
}

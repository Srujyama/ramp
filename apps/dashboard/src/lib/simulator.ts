/**
 * @ramp/dashboard — Policy Simulator (pure logic)
 *
 * Side-effect-free helpers for the read-only "Policy Simulator" on the Policy
 * page. NOTHING here calls the bridge, persists a decision, produces a proof, or
 * executes a payment — it only shapes hypothetical inputs and renders the checks
 * the kernel would evaluate. The one network call (an idempotent GET
 * `simulatePolicy`) lives in bridge.ts; this module never touches the wire.
 *
 * Kept pure so it can be unit-tested with `node:test` and so Policy.tsx stays thin.
 */
import { formatMoney } from "./format.js";
import type { Facts } from "./types.js";

// --- form model --------------------------------------------------------------

export type SimField = "agent" | "vendor" | "amount" | "category" | "currency";

/** The raw (string) form values, before validation/coercion. */
export interface SimFormValues {
  agent: string;
  vendor: string;
  amount: string;
  category: string;
  currency: string;
}

export const EMPTY_SIM_FORM: SimFormValues = {
  agent: "",
  vendor: "",
  amount: "",
  category: "",
  currency: "USD",
};

export interface SimValidation {
  errors: Partial<Record<SimField, string>>;
  valid: boolean;
  /** Parsed amount (only meaningful when `valid` and the amount field is ok). */
  amount: number;
}

/**
 * Validate a simulator form. Amounts must be non-negative whole currency units
 * (matching `Facts.amount`). Returns a per-field error map; empty ⇒ valid.
 */
export function validateSimForm(v: SimFormValues): SimValidation {
  const errors: Partial<Record<SimField, string>> = {};
  if (!v.agent.trim()) errors.agent = "Agent id is required.";
  if (!v.vendor.trim()) errors.vendor = "Vendor id is required.";
  if (!v.category.trim()) errors.category = "Category is required.";

  const raw = v.amount.trim();
  const amount = Number(raw);
  if (raw === "" || !Number.isFinite(amount)) {
    errors.amount = "Enter an amount.";
  } else if (amount < 0) {
    errors.amount = "Amount must be non-negative.";
  } else if (!Number.isInteger(amount)) {
    errors.amount = "Whole currency units only (no cents).";
  }

  return { errors, valid: Object.keys(errors).length === 0, amount };
}

// --- policy checks (derived from the authoritative facts) --------------------

/** One row of the "what the policy examined" checklist. */
export interface PolicyCheck {
  key: string;
  /** What the policy examined. */
  label: string;
  /** The concrete comparison the kernel made, in plain language. */
  detail: string;
  /** Did this individual check pass? */
  pass: boolean;
}

/**
 * Derive the compact checklist of policy conditions from the authoritative
 * `Facts` the kernel evaluated. This mirrors the kernel's rules 1:1 (per-txn cap,
 * daily limit, vendor verification, approved category, agent clearance) but makes
 * NO decision itself — `explainSimulation`/`outcome` own the verdict.
 */
export function policyChecks(facts: Facts, currency: string): PolicyCheck[] {
  const m = (n: number): string => formatMoney(n, currency);
  const projectedDaily = facts.daily_total_so_far + facts.amount;
  const categoryApproved = facts.approved_categories.includes(facts.category);
  const agentCleared = facts.agent_cleared_categories.includes(facts.category);

  return [
    {
      key: "per_txn_cap",
      label: "Per-transaction cap",
      pass: facts.amount <= facts.per_txn_cap,
      detail: `${m(facts.amount)} vs cap ${m(facts.per_txn_cap)}`,
    },
    {
      key: "daily_limit",
      label: "Daily limit",
      pass: projectedDaily <= facts.daily_limit,
      detail: `${m(facts.daily_total_so_far)} spent + ${m(facts.amount)} = ${m(
        projectedDaily,
      )} vs limit ${m(facts.daily_limit)}`,
    },
    {
      key: "vendor_verified",
      label: "Vendor verified",
      pass: facts.vendor_verified,
      detail: facts.vendor_verified
        ? `${facts.vendor} is verified in the registry`
        : `${facts.vendor} is absent or unverified in the registry`,
    },
    {
      key: "category_approved",
      label: "Category approved",
      pass: categoryApproved,
      detail: categoryApproved
        ? `${facts.category} is on the org's approved list`
        : `${facts.category} is not on the org's approved list`,
    },
    {
      key: "agent_cleared",
      label: "Agent cleared for category",
      pass: agentCleared,
      detail: agentCleared
        ? `${facts.requesting_agent} is cleared for ${facts.category}`
        : `${facts.requesting_agent} is not cleared for ${facts.category}`,
    },
  ];
}

// --- policy digest display ---------------------------------------------------

/**
 * Truncate a "sha256:<hex>" policy digest for display while keeping it
 * recognizable, e.g. "sha256:abcd12…". The full value is still what gets copied.
 */
export function truncateDigest(digest: string, keep = 6): string {
  const [algo, ...rest] = digest.split(":");
  const hash = rest.join(":");
  if (!hash) return digest;
  if (hash.length <= keep) return digest;
  return `${algo}:${hash.slice(0, keep)}…`;
}

// --- seeded example scenarios ------------------------------------------------

/** A prefill-only example (clicking it fills the form; it never auto-runs). */
export interface Scenario {
  id: string;
  title: string;
  /** The outcome we expect given the seeded demo policy (documentation only). */
  expect: "allow" | "deny" | "escalate";
  /** Why this scenario is interesting. */
  note: string;
  input: {
    agent: string;
    vendor: string;
    amount: number;
    category: string;
    currency: string;
  };
}

/**
 * Scenarios use the ids from the ledger demo seed (packages/ledger/sql/seed.sql):
 *   agent:      agent_47 (cleared for office_supplies + software, NOT travel)
 *   vendors:    acme_corp (verified), sketchy_llc / unknown_labs (unverified)
 *   categories: office_supplies / software / travel (approved), crypto (not approved)
 *   policy:     per_txn_cap 500, daily_limit 1500, ~1140 already spent today
 * Coordinator: confirm these still match seed.sql before demo.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: "allow_happy_path",
    title: "Allowed: happy path",
    expect: "allow",
    note: "Verified vendor, approved+cleared category, under cap, 1140 + 340 ≤ 1500.",
    input: { agent: "agent_47", vendor: "acme_corp", amount: 340, category: "office_supplies", currency: "USD" },
  },
  {
    id: "deny_vendor_unverified",
    title: "Denied: vendor not verified",
    expect: "deny",
    note: "sketchy_llc is not verified in the vendor registry.",
    input: { agent: "agent_47", vendor: "sketchy_llc", amount: 100, category: "office_supplies", currency: "USD" },
  },
  {
    id: "deny_over_cap",
    title: "Denied: over per-transaction cap",
    expect: "deny",
    note: "600 exceeds the 500 per-transaction cap.",
    input: { agent: "agent_47", vendor: "acme_corp", amount: 600, category: "office_supplies", currency: "USD" },
  },
  {
    id: "deny_category_not_approved",
    title: "Denied: category not approved",
    expect: "deny",
    note: "crypto is explicitly not on the approved category list.",
    input: { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "crypto", currency: "USD" },
  },
  {
    id: "deny_agent_uncleared",
    title: "Denied: agent not cleared",
    expect: "deny",
    note: "travel is approved org-wide, but agent_47 is not cleared for it.",
    input: { agent: "agent_47", vendor: "acme_corp", amount: 100, category: "travel", currency: "USD" },
  },
  {
    id: "deny_daily_limit",
    title: "Denied: daily limit exceeded",
    expect: "deny",
    note: "Under the per-txn cap, but 1140 + 400 = 1540 > 1500 daily limit.",
    input: { agent: "agent_47", vendor: "acme_corp", amount: 400, category: "office_supplies", currency: "USD" },
  },
  {
    id: "escalate_over_threshold",
    title: "Escalate: needs human approval",
    expect: "escalate",
    note:
      "$450 is within every hard cap, but above the $400 escalation threshold. Uses agent_12 " +
      "(zero spend today) so it can't collide with agent_47's daily total and deny instead. " +
      "Deny dominates escalate, so this only reads as escalate with headroom to spare.",
    input: { agent: "agent_12", vendor: "acme_corp", amount: 450, category: "office_supplies", currency: "USD" },
  },
  {
    id: "escalate_elevated_risk_vendor",
    title: "Escalate: elevated-risk vendor",
    expect: "escalate",
    note: "newco_ltd is verified and real, but onboarded yesterday. A human glance is cheap.",
    input: { agent: "agent_12", vendor: "newco_ltd", amount: 100, category: "office_supplies", currency: "USD" },
  },
];

/** Turn a scenario's typed input into raw form values (amount → string). */
export function scenarioToForm(s: Scenario): SimFormValues {
  return {
    agent: s.input.agent,
    vendor: s.input.vendor,
    amount: String(s.input.amount),
    category: s.input.category,
    currency: s.input.currency,
  };
}

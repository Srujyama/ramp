/**
 * @ramp/ledger — policy-digest.ts
 *
 * A STABLE identity for the org policy that judged a spend request.
 *
 * This does NOT invent a new hashing scheme: it reuses the existing canonical-hash
 * {@link digestOf} (RFC-8785-shaped, `sha256:<hex>`), exactly like request/facts
 * digests in proof.ts. The digest identifies WHICH policy produced a decision so
 * two decisions made under the same org policy share one policy identity — and any
 * change to the org policy changes it.
 *
 * It is derived ONLY from the org-level policy fields (`per_txn_cap`, `daily_limit`,
 * `approved_categories`). Agent-specific facts (e.g. `agent_cleared_categories`,
 * `requesting_agent`) and request-specific facts (`amount`, `vendor`, `category`,
 * `daily_total_so_far`, ...) are deliberately EXCLUDED: they vary per agent/request
 * under one unchanged policy, so including them would break stability.
 *
 * This is a content identity, NOT a semantic version number: it does not assign
 * "v1/v2" or assert any ordering. Historical policy versioning — approval workflow,
 * rollback, and a policy-change audit trail of its own — is deliberate FUTURE WORK,
 * not something this digest attempts to provide.
 */
import type { Facts } from "@ramp/shared";
import { digestOf, type Json } from "./canonical-hash.js";

/** The org-level policy fields that constitute a stable policy identity. */
export interface PolicyDocument {
  readonly perTxnCap: number;
  readonly dailyLimit: number;
  readonly approvedCategories: readonly string[];
}

/** Project the three org-policy fields out of a `Facts` object. */
export function policyDocumentOf(facts: Facts): PolicyDocument {
  return {
    perTxnCap: facts.per_txn_cap,
    dailyLimit: facts.daily_limit,
    approvedCategories: facts.approved_categories,
  };
}

/**
 * Stable "sha256:<hex>" identity of the org policy that judged a request. Derived
 * only from the org-level policy fields, never agent-specific or request-specific
 * data, so it is stable across agents/requests under the same policy.
 */
export function policyDigest(facts: Facts): string {
  return digestOf(policyDocumentOf(facts) as unknown as Json);
}

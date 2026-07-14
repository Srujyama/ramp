/**
 * @ramp/shared — Fact translation (THE ANTI-INJECTION SEAM)
 *
 * ============================================================================
 * TRUST BOUNDARY. READ THIS BEFORE TOUCHING THIS FILE.
 * ============================================================================
 * A `SpendRequest` is UNTRUSTED transport. Its scalar values — `amount`,
 * `vendorId`, `category`, `requestingAgent` — are supplied by (or influenced by)
 * a model that can be prompt-injected. We use those values ONLY as KEYS to look
 * up the truth, never as the truth itself.
 *
 * The security-critical facts — `vendor_verified`, `daily_total_so_far`,
 * `per_txn_cap`, `daily_limit`, `approved_categories`,
 * `agent_cleared_categories` — come from an AUTHORITATIVE source: the ledger DB
 * and vendor registry, read out-of-band by `@ramp/ledger`. They are handed to
 * `translateToFacts` as an `AuthoritativeFacts` object. THE MODEL CANNOT FORGE
 * THEM: it has no path to set `vendor_verified: true` or shrink
 * `daily_total_so_far` by narrating cleverly, because those fields are never
 * copied out of the request.
 *
 * The whole security argument is: "same Facts -> same Decision (the kernel is
 * pure + deterministic), AND the Facts are true (they come from here, from the
 * DB, not from narration)." If any authoritative scalar were ever sourced from
 * the `SpendRequest`, that argument collapses. So:
 *
 *   - From the request we take: request_id (invoiceRef), requesting_agent,
 *     amount, vendor, category  — identity/intent KEYS only.
 *   - From the authoritative context we take EVERYTHING that gates the decision.
 *
 * These `Facts` fields map 1:1 onto the Souffle input relations in
 * `@ramp/gate/policy.dl`. Keep this file, `facts.ts`, and `policy.dl` in lockstep.
 * ============================================================================
 */
import type { Facts } from "./facts.js";
import type { SpendRequest } from "./spend-request.js";

/**
 * The bundle of AUTHORITATIVE facts the ledger data-access layer
 * (`@ramp/ledger`'s `LedgerFactSource`) returns for one request. Every field
 * here is a PURE DB / registry read keyed off the request's identity — NONE of
 * it is ever derived from the model's narration.
 *
 * `@ramp/ledger`'s `AuthoritativeFactSource.contextFor(req)` produces exactly
 * this shape; `translateToFacts` merges it with the request's identity keys to
 * produce the closed `Facts` object the kernel evaluates.
 */
export interface AuthoritativeFacts {
  /**
   * True iff the request's vendor is present AND `verified = 1` in the vendor
   * registry. Looked up by `vendorId`; the model cannot assert this.
   */
  readonly vendorVerified: boolean;
  /**
   * The requesting agent's total spend so far today, summed from the immutable
   * ledger. Looked up by `requestingAgent`; the model cannot shrink it.
   */
  readonly dailyTotalSoFar: number;
  /** Org single-transaction cap, from `policy_limits`. */
  readonly perTxnCap: number;
  /** Org daily aggregate limit, from `policy_limits`. */
  readonly dailyLimit: number;
  /** The org's approved category list, from `categories` where `approved = 1`. */
  readonly approvedCategories: readonly string[];
  /**
   * The categories THIS agent is cleared to spend in, from
   * `agent_category_clearances`. Looked up by `requestingAgent`.
   */
  readonly agentClearedCategories: readonly string[];
  /**
   * True iff a TLSNotary-style attestation accompanied this request (Day 4
   * layer). Established out-of-band by the attestation layer, never asserted by
   * the model. Optional so Phase 0 callers may omit it (defaults to `false`).
   */
  readonly attestationPresent?: boolean;
}

/**
 * Options for `translateToFacts`. Kept as an object so the seam can grow without
 * breaking callers.
 */
export interface TranslateOptions {
  /**
   * The `request_id` to stamp onto the produced `Facts`. If omitted, the
   * request's `invoiceRef` is used; if that too is absent, the empty string.
   * (The kernel treats `request_id` as an opaque label — it does not gate on it.)
   */
  readonly requestId?: string;
}

/**
 * Merge one UNTRUSTED `SpendRequest` (identity/intent keys only) with the
 * AUTHORITATIVE facts read from the ledger/registry into the closed `Facts`
 * object the policy kernel evaluates.
 *
 * TRUST BOUNDARY (enforced by construction here — see file header):
 *   - Identity/intent KEYS from the request: `request_id`, `requesting_agent`,
 *     `amount`, `vendor`, `category`.
 *   - EVERY gating fact from `authoritative`: `vendor_verified`,
 *     `daily_total_so_far`, `per_txn_cap`, `daily_limit`, `approved_categories`,
 *     `agent_cleared_categories`, `attestation_present`.
 *
 * No authoritative scalar is ever copied out of `request`. This function is pure
 * and deterministic: identical inputs -> identical `Facts`.
 *
 * @param request      the untrusted tool_input (validate with `isSpendRequest` first)
 * @param authoritative the ledger/registry read for this request
 * @param options      optional `request_id` override (defaults to `invoiceRef`)
 */
export function translateToFacts(
  request: SpendRequest,
  authoritative: AuthoritativeFacts,
  options: TranslateOptions = {},
): Facts {
  const request_id = options.requestId ?? request.invoiceRef ?? "";

  return {
    // --- Identity / intent KEYS (from the untrusted request) -----------------
    request_id,
    requesting_agent: request.requestingAgent,
    amount: request.amount,
    vendor: request.vendorId,
    category: request.category,

    // --- AUTHORITATIVE gating facts (from the ledger/registry, NEVER the model)
    vendor_verified: authoritative.vendorVerified,
    daily_total_so_far: authoritative.dailyTotalSoFar,
    per_txn_cap: authoritative.perTxnCap,
    daily_limit: authoritative.dailyLimit,
    approved_categories: authoritative.approvedCategories,
    agent_cleared_categories: authoritative.agentClearedCategories,
    // Day-4 layer; absent authoritative attestation => false (fail-closed default).
    attestation_present: authoritative.attestationPresent ?? false,
  };
}

/**
 * The context an `AuthoritativeFactSource` needs to look up facts: the untrusted
 * request whose identity keys drive the DB/registry reads.
 */
export interface AuthoritativeContext {
  /** The untrusted request under evaluation (keys only are trusted). */
  readonly request: SpendRequest;
}

/**
 * The port `@ramp/ledger` implements: given the request (identity keys), return
 * the AUTHORITATIVE facts for it. Implementations MUST perform pure DB/registry
 * reads and MUST NOT trust any scalar value from the request as a fact.
 *
 * Kept in `@ramp/shared` so the ledger, the hook, and tests all depend on the
 * same seam type rather than on a concrete implementation.
 */
export interface AuthoritativeFactSource {
  /**
   * Read the authoritative facts for `ctx.request` from the ledger/registry.
   * May be sync or async (DB drivers differ); callers `await` the result.
   */
  contextFor(
    ctx: AuthoritativeContext,
  ): AuthoritativeFacts | Promise<AuthoritativeFacts>;
}

/**
 * Convenience: pull the authoritative facts from `source` for `request`, then
 * translate to `Facts` in one call. Awaits the source (which may be sync or
 * async). Pure aside from the source's DB read.
 *
 * @param request the untrusted tool_input (validate with `isSpendRequest` first)
 * @param source  the ledger/registry-backed authoritative fact source
 * @param options optional `request_id` override
 */
export async function factsFromContext(
  request: SpendRequest,
  source: AuthoritativeFactSource,
  options: TranslateOptions = {},
): Promise<Facts> {
  const authoritative = await source.contextFor({ request });
  return translateToFacts(request, authoritative, options);
}

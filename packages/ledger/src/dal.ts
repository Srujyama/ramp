/**
 * @ramp/ledger — dal.ts (the anti-injection seam)
 *
 * The Data Access Layer. This is where the AUTHORITATIVE, security-critical facts
 * are read — always from the SQLite fact store, NEVER from the model's narration.
 * The hook uses the untrusted `SpendRequest` fields ONLY as lookup keys here; the
 * values that come back out are the ground truth the policy kernel judges.
 *
 * `contextFor(ctx)` implements @ramp/shared's `AuthoritativeFactSource` port and
 * returns the `AuthoritativeFacts` the shared translator consumes
 * (`factsFromContext` / `translateToFacts`). camelCase here -> snake_case `Facts`.
 *
 * FAIL-CLOSED DISCIPLINE. Every read below distinguishes "the authoritative
 * answer is zero/false" from "I could not authoritatively answer", and THROWS on
 * the latter. That distinction is the whole ballgame: a fact source that returns
 * a permissive default when it doesn't know is a fact source that fails open.
 */
import type {
  AuthoritativeContext,
  AuthoritativeFactSource,
  AuthoritativeFacts,
} from "@ramp/shared";
import type { FactProvenance } from "@ramp/provenance";
import type { LedgerDb } from "./db.js";

/**
 * The authoritative queries, as named constants.
 *
 * These exist so PROVENANCE CANNOT DRIFT FROM REALITY. The provenance graph
 * claims "this fact is the result of this exact SQL" — a claim an auditor is
 * invited to go and re-run against the database. If the recorded query were a
 * hand-written copy of the real one, the two would diverge on the first refactor
 * and the graph would start telling confident, checkable, false stories. Worse
 * than no provenance: a plausible lie.
 *
 * So the query the DAL executes and the query the provenance records are the
 * same string, by construction.
 */
export const LEDGER_QUERIES = {
  agentExists: "SELECT 1 AS ok FROM agents WHERE agent_id = ?",
  dailyTotalSoFar:
    "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE agent_id = ? AND date(ts) = date('now')",
  vendorVerified: "SELECT verified FROM vendors WHERE vendor_id = ?",
  vendorDomain: "SELECT registry_domain FROM vendors WHERE vendor_id = ?",
  limits:
    "SELECT per_txn_cap, daily_limit, escalation_threshold, currency FROM policy_limits WHERE id = 1",
  vendorRiskTier: "SELECT risk_tier FROM vendors WHERE vendor_id = ?",
  approvedCategories:
    "SELECT category_id FROM categories WHERE approved = 1 ORDER BY category_id",
  agentClearances:
    "SELECT category_id FROM agent_category_clearances WHERE agent_id = ? ORDER BY category_id",
} as const;

/** Org policy limits, read from the single-row `policy_limits` table. */
export interface Limits {
  readonly perTxnCap: number;
  readonly dailyLimit: number;
  /** Amount above which a human must approve, even within the hard caps. */
  readonly escalationThreshold: number;
  readonly currency: string;
}

/**
 * Thrown when a request names an agent that does not exist in the registry.
 *
 * SECURITY: an unknown agent must never be served facts. Summing an empty
 * ledger for `agent_ghost` yields `daily_total_so_far = 0` — a full fresh daily
 * budget for an identity nobody provisioned. Today an unknown agent also has no
 * clearances, so it happens to deny on `agent_uncleared_for_category`; that is
 * incidental defence, not design. We refuse explicitly instead of relying on a
 * second rule to catch it.
 */
export class UnknownAgentError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(
      `@ramp/ledger: agent "${agentId}" is not in the agent registry — refusing to ` +
        `synthesise facts for an unknown identity (an empty ledger reads as zero spend).`,
    );
    this.name = "UnknownAgentError";
    this.agentId = agentId;
  }
}

/**
 * LedgerFactSource — the authoritative fact source over a live SQLite handle.
 *
 * Declares `implements AuthoritativeFactSource` deliberately: the port and this
 * class previously disagreed on `contextFor`'s signature (the port passed a
 * `{ request }` wrapper, this class expected a bare `SpendRequest`) and nothing
 * caught it, because without an `implements` clause TypeScript never compares
 * them. The mismatch was live: `factsFromContext(req, ledgerSource)` threw
 * "Provided value cannot be bound to SQLite parameter 1" at runtime. The clause
 * below makes that class of drift a compile error.
 */
export class LedgerFactSource implements AuthoritativeFactSource {
  readonly #db: LedgerDb;

  constructor(db: LedgerDb) {
    this.#db = db;
  }

  /** True iff the agent id exists in the `agents` registry. */
  agentExists(agentId: string): boolean {
    const row = this.#db.prepare(LEDGER_QUERIES.agentExists).get(agentId) as
      | { ok: number }
      | undefined;
    return !!row;
  }

  /**
   * Sum of the agent's spend so far TODAY (UTC calendar day), in whole units.
   * Uses SQLite `date()` so "today" is derived in the DB, not from JS narration.
   *
   * Throws {@link UnknownAgentError} for an unregistered agent rather than
   * returning 0 — see the class docs. A registered agent with no spend today
   * legitimately returns 0.
   */
  getDailyTotalSoFar(agentId: string): number {
    if (!this.agentExists(agentId)) throw new UnknownAgentError(agentId);
    const row = this.#db.prepare(LEDGER_QUERIES.dailyTotalSoFar).get(agentId) as
      | { total: number }
      | undefined;
    return row ? Number(row.total) : 0;
  }

  /**
   * True iff the vendor id is present in the registry AND `verified = 1`.
   * A missing vendor is NOT verified (fail-closed).
   */
  isVendorVerified(vendorId: string): boolean {
    const row = this.#db.prepare(LEDGER_QUERIES.vendorVerified).get(vendorId) as
      | { verified: number }
      | undefined;
    return !!row && row.verified === 1;
  }

  /**
   * The vendor's registry risk tier. An unregistered vendor is `"unknown"` —
   * NOT `"trusted"`. A vendor we have never heard of is the least familiar thing
   * there is, and defaulting an unknown to the most permissive tier is the exact
   * shape of a fail-open. (It denies on `vendor_not_verified` first anyway, but
   * the default should be right on its own.)
   */
  getVendorRiskTier(vendorId: string): string {
    const row = this.#db.prepare(LEDGER_QUERIES.vendorRiskTier).get(vendorId) as
      | { risk_tier: string | null }
      | undefined;
    return row?.risk_tier ?? "unknown";
  }

  /** The vendor's registered domain, or null if absent/unregistered. */
  getVendorDomain(vendorId: string): string | null {
    const row = this.#db.prepare(LEDGER_QUERIES.vendorDomain).get(vendorId) as
      | { registry_domain: string | null }
      | undefined;
    return row?.registry_domain ?? null;
  }

  /** Org policy limits (per-txn cap + daily limit). Throws if unprovisioned. */
  getLimits(): Limits {
    const row = this.#db.prepare(LEDGER_QUERIES.limits).get() as
      | {
          per_txn_cap: number;
          daily_limit: number;
          escalation_threshold: number;
          currency: string;
        }
      | undefined;
    if (!row) {
      throw new Error(
        "@ramp/ledger: policy_limits row (id=1) missing — DB is not provisioned.",
      );
    }
    return {
      perTxnCap: Number(row.per_txn_cap),
      dailyLimit: Number(row.daily_limit),
      escalationThreshold: Number(row.escalation_threshold),
      currency: row.currency,
    };
  }

  /** The org's approved category ids (those with `approved = 1`), sorted. */
  getApprovedCategories(): string[] {
    const rows = this.#db.prepare(LEDGER_QUERIES.approvedCategories).all() as Array<{
      category_id: string;
    }>;
    return rows.map((r) => r.category_id);
  }

  /** The category ids THIS agent is cleared to spend in, sorted. */
  getAgentClearances(agentId: string): string[] {
    const rows = this.#db.prepare(LEDGER_QUERIES.agentClearances).all(agentId) as Array<{
      category_id: string;
    }>;
    return rows.map((r) => r.category_id);
  }

  /**
   * Assemble the full `AuthoritativeFacts` bundle for one request. The
   * `SpendRequest` fields are used ONLY as lookup keys (`vendorId`,
   * `requestingAgent`); every returned value is an authoritative DB read.
   *
   * `attestationPresent` is supplied by the caller's attestation layer
   * (@ramp/attestation verifies the signature out of band) and defaults to
   * false. It is NEVER read off the request.
   */
  contextFor(ctx: AuthoritativeContext): AuthoritativeFacts {
    const req = ctx.request;
    const limits = this.getLimits();
    return {
      vendorVerified: this.isVendorVerified(req.vendorId),
      dailyTotalSoFar: this.getDailyTotalSoFar(req.requestingAgent),
      perTxnCap: limits.perTxnCap,
      dailyLimit: limits.dailyLimit,
      approvedCategories: this.getApprovedCategories(),
      agentClearedCategories: this.getAgentClearances(req.requestingAgent),
      attestationPresent: ctx.attestationPresent ?? false,
      escalationThreshold: limits.escalationThreshold,
      vendorRiskTier: this.getVendorRiskTier(req.vendorId),
    };
  }

  /**
   * The provenance entries for exactly the facts THIS source produced.
   *
   * Six of the twelve `Facts` fields: the ones that gate the decision. The other
   * six (the identity/intent keys and the attestation verdict) are recorded by
   * their own producers — the hook and @ramp/attestation respectively — because
   * the rule that keeps provenance honest is that WHOEVER SOURCES A FACT RECORDS
   * IT. A central recorder that describes reads it did not perform is writing
   * fiction, and it drifts on the first refactor.
   *
   * Note every `query` below is the same constant the read actually executed.
   */
  provenanceFor(ctx: AuthoritativeContext, facts: AuthoritativeFacts): FactProvenance[] {
    const req = ctx.request;
    return [
      {
        fact: "vendor_verified",
        value: facts.vendorVerified,
        source: "vendor_registry",
        derivation: {
          kind: "sql",
          table: "vendors",
          query: LEDGER_QUERIES.vendorVerified,
          params: [req.vendorId],
        },
      },
      {
        fact: "daily_total_so_far",
        value: facts.dailyTotalSoFar,
        source: "ledger_db",
        derivation: {
          kind: "sql",
          table: "ledger_entries",
          query: LEDGER_QUERIES.dailyTotalSoFar,
          params: [req.requestingAgent],
        },
      },
      {
        fact: "per_txn_cap",
        value: facts.perTxnCap,
        source: "policy_config",
        derivation: {
          kind: "sql",
          table: "policy_limits",
          query: LEDGER_QUERIES.limits,
          params: [],
        },
      },
      {
        fact: "daily_limit",
        value: facts.dailyLimit,
        source: "policy_config",
        derivation: {
          kind: "sql",
          table: "policy_limits",
          query: LEDGER_QUERIES.limits,
          params: [],
        },
      },
      {
        fact: "approved_categories",
        value: facts.approvedCategories,
        source: "policy_config",
        derivation: {
          kind: "sql",
          table: "categories",
          query: LEDGER_QUERIES.approvedCategories,
          params: [],
        },
      },
      {
        fact: "escalation_threshold",
        value: facts.escalationThreshold,
        source: "policy_config",
        derivation: {
          kind: "sql",
          table: "policy_limits",
          query: LEDGER_QUERIES.limits,
          params: [],
        },
      },
      {
        fact: "vendor_risk_tier",
        value: facts.vendorRiskTier,
        source: "vendor_registry",
        derivation: {
          kind: "sql",
          table: "vendors",
          query: LEDGER_QUERIES.vendorRiskTier,
          params: [req.vendorId],
        },
      },
      {
        fact: "agent_cleared_categories",
        value: facts.agentClearedCategories,
        source: "policy_config",
        derivation: {
          kind: "sql",
          table: "agent_category_clearances",
          query: LEDGER_QUERIES.agentClearances,
          params: [req.requestingAgent],
        },
      },
    ];
  }

  /**
   * Read the authoritative facts AND their provenance in one pass, so the two
   * cannot describe different reads. Preferred over calling `contextFor` and
   * `provenanceFor` separately.
   */
  contextWithProvenance(ctx: AuthoritativeContext): {
    facts: AuthoritativeFacts;
    provenance: FactProvenance[];
  } {
    const facts = this.contextFor(ctx);
    return { facts, provenance: this.provenanceFor(ctx, facts) };
  }
}

/** Convenience: build a `LedgerFactSource` over an already-open DB handle. */
export function makeFactSource(db: LedgerDb): LedgerFactSource {
  return new LedgerFactSource(db);
}

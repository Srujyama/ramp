/**
 * @ramp/ledger — purchase.ts (the shared purchase lifecycle / MODULE A)
 *
 * `requestPurchase` is the ONE fail-closed path an agent's spend request travels:
 * guard → authoritative facts → policy evaluation → decision id → trusted
 * provenance → tamper-evident proof → atomic audit write → INDEPENDENT re-verify →
 * (only then, and only for an allowed + persisted + verified decision) execute.
 *
 * SECURITY POSTURE (the whole point):
 *   - The executor is called LAST and ONLY for an allowed, persisted, and
 *     independently re-verified decision. A DENY never touches the executor.
 *   - Fail-closed at every step: any facts/kernel/provenance/proof construction
 *     failure is a `policy_error` with NO execution; any audit-write failure
 *     (including a `DecisionConflictError`) or a proof that does not re-verify is
 *     an `audit_error` with NO execution.
 *   - This module holds NO policy logic. It delegates to the injected kernel and
 *     stores the kernel's `Decision` verbatim — it is not a second policy path.
 *   - `decisionId` is a deterministic content hash (or the caller's idempotency
 *     key), so an identical retry collapses to a ledger no-op and a same-key /
 *     different-content replay is surfaced as a conflict, never silently executed.
 *   - Nothing here logs or returns secrets, card numbers, or provider credentials.
 *
 * DEPENDENCY INJECTION: the kernel, fact source, db handle, and payment executor
 * are all injected, so this path is unit-testable with zero network and a fake
 * in-memory executor.
 */
import {
  isSpendRequest,
  translateToFacts,
  type SpendRequest,
  type Facts,
  type Decision,
  type PolicyKernel,
  type AuthoritativeFacts,
  type AuthoritativeFactSource,
} from "@ramp/shared";
import {
  recordDecision,
  recordExecution,
  getDecision,
  DecisionConflictError,
} from "./decision-log.js";
import { buildProof, type LedgerProof } from "./proof.js";
import { policyDigest } from "./policy-digest.js";
import { buildDecisionProvenance } from "./provenance-builder.js";
import { verifyDecisionProof } from "./proof-verification.js";
import { sha256OfJson, type Json } from "./canonical-hash.js";
import type { LedgerDb } from "./db.js";

// --- injected ports ----------------------------------------------------------

/** What the sandbox executor is handed. `idempotencyKey === decisionId`. */
export interface ExecutorRequest {
  /** Stable decision id; equals the idempotency key. */
  readonly decisionId: string;
  /** Idempotency key; equals `decisionId` so retries collapse. */
  readonly idempotencyKey: string;
  /** The structured spend request (vendorId, amount, currency, category, requestingAgent, invoiceRef?). */
  readonly request: SpendRequest;
}

/** The executor's settlement receipt. MUST NOT carry secrets/credentials. */
export interface ExecutorReceipt {
  /** Provider settlement id. */
  readonly receiptId: string;
  /** Execution-scoped id; NOT a policy-correlation id. */
  readonly executionId: string;
  readonly status: "settled" | "failed";
  /** e.g. "sandbox". */
  readonly provider: string;
}

/** The injected payment executor. Sandbox-only; no real money moves. */
export interface PaymentExecutor {
  execute(req: ExecutorRequest): Promise<ExecutorReceipt> | ExecutorReceipt;
}

/**
 * DI-friendly fact-source port.
 *
 * This is now an ALIAS of @ramp/shared's `AuthoritativeFactSource` rather than a
 * second, structurally-similar interface. It was declared here independently,
 * with `contextFor(req: SpendRequest)` — the same signature the shared port used
 * to have and no longer does. Two hand-maintained copies of one seam drift the
 * moment either moves, and this one had already started to: the shared port
 * takes an `AuthoritativeContext` wrapper so out-of-band verdicts (the
 * attestation result) can reach the fact source, and this copy could not express
 * that. Aliasing means there is exactly one definition to keep honest.
 */
export type FactSourcePort = AuthoritativeFactSource;

// --- result vocabulary -------------------------------------------------------

/**
 * The terminal status of a purchase attempt.
 *   - `allowed`        — policy allow, persisted, verified, executed OK.
 *   - `denied`         — policy deny; NO execution.
 *   - `policy_error`   — facts/kernel/provenance/proof construction failed; NO execution.
 *   - `audit_error`    — recordDecision failed OR proof did not verify; NO execution.
 *   - `executor_error` — allowed + persisted + verified, but the executor threw / returned failed.
 */
export type PurchaseStatus =
  | "allowed"
  | "denied"
  | "policy_error"
  | "audit_error"
  | "executor_error";

/** Everything `requestPurchase` needs — all external effects are injected. */
export interface RequestPurchaseInput {
  readonly request: SpendRequest;
  /** Injected policy kernel (e.g. `getKernel().kernel`). */
  readonly kernel: PolicyKernel;
  /** Injected kernel identity (e.g. `getKernel().kind`). */
  readonly kernelId?: string;
  /** Injected authoritative fact source (e.g. `new LedgerFactSource(db)`). */
  readonly factSource: FactSourcePort;
  /** Open ledger handle. */
  readonly db: LedgerDb;
  /** Injected sandbox payment executor. */
  readonly executor: PaymentExecutor;
  /**
   * The attestation layer's VERIFIED verdict for this request. Defaults to
   * `false` — fail-closed.
   *
   * Injected rather than computed here, for the same reason the kernel and the
   * fact source are: verification is somebody else's job. @ramp/attestation owns
   * the signature and binding checks; this module owns the lifecycle. Both the
   * hook and the MCP server call the same `verifyAttestation` and hand the
   * resulting boolean in — one verifier, two call sites, no second opinion.
   *
   * The default matters. `deny/attestation_invalid` (policy.dl D6) denies without
   * a verified attestation, so a caller that forgets to pass this gets a DENY,
   * never an accidental allow. Omitting it is safe; that is the point of the
   * default pointing this way.
   */
  readonly attestationPresent?: boolean;
  /** When given, used as `decisionId` — enables same-key conflict detection. */
  readonly idempotencyKey?: string;
  /** OPTIONAL trusted provenance node; omitted from the graph when not genuinely present. */
  readonly toolCallId?: string;
  /** OPTIONAL trusted provenance node; omitted from the graph when not genuinely present. */
  readonly taskId?: string;
  /** Deterministic proof production time (epoch ms) for tests; defaults to `Date.now()`. */
  readonly producedAt?: number;
}

/** The structured receipt/denial an agent gets back. Never carries secrets. */
export interface RequestPurchaseResult {
  readonly status: PurchaseStatus;
  readonly decisionId: string | null;
  readonly outcome: "allow" | "deny" | null;
  readonly firedRules: readonly string[];
  readonly reasons: readonly string[];
  readonly proofId: string | null;
  readonly proofVerified: boolean;
  readonly receipt: ExecutorReceipt | null;
  readonly executed: boolean;
  /** Concise, agent-readable summary. No secrets. */
  readonly message: string;
  /** Correlation label = `facts.request_id` (invoiceRef) or `decisionId`. */
  readonly requestId: string;
}

// --- internal helpers --------------------------------------------------------

/** Structural guard for a `Decision` the kernel returns (reject malformed → policy_error). */
function isValidDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.decision === "allow" || v.decision === "deny") &&
    Array.isArray(v.reasons) &&
    v.reasons.every((r) => typeof r === "string") &&
    Array.isArray(v.firedRules) &&
    v.firedRules.every((r) => typeof r === "string")
  );
}

/** Best-effort correlation label before facts exist (never throws). */
function fallbackRequestId(request: SpendRequest): string {
  return typeof request.invoiceRef === "string" ? request.invoiceRef : "";
}

/**
 * Persist the sandbox execution receipt to the audit trail, best-effort. The
 * money-movement decision is ALREADY durably recorded + verified by this point,
 * so a failure to log the receipt must NEVER change the purchase result — it only
 * means the receipt won't appear in the audit view. Records `settled` and
 * `failed` alike (a failed receipt is a genuine, auditable executor outcome).
 */
function persistExecution(
  db: LedgerDb,
  decisionId: string,
  receipt: ExecutorReceipt,
): void {
  try {
    recordExecution(db, {
      decisionId,
      receiptId: receipt.receiptId,
      executionId: receipt.executionId,
      status: receipt.status,
      provider: receipt.provider,
    });
  } catch {
    /* audit-of-execution is supplementary; never fail the purchase on it. */
  }
}

/** Fill a complete result from a partial, defaulting every optional field. */
function makeResult(
  partial: Pick<RequestPurchaseResult, "status" | "message" | "requestId"> &
    Partial<RequestPurchaseResult>,
): RequestPurchaseResult {
  return {
    status: partial.status,
    decisionId: partial.decisionId ?? null,
    outcome: partial.outcome ?? null,
    firedRules: partial.firedRules ?? [],
    reasons: partial.reasons ?? [],
    proofId: partial.proofId ?? null,
    proofVerified: partial.proofVerified ?? false,
    receipt: partial.receipt ?? null,
    executed: partial.executed ?? false,
    message: partial.message,
    requestId: partial.requestId,
  };
}

// --- the lifecycle -----------------------------------------------------------

/**
 * Run one spend request through the fail-closed purchase lifecycle. See the file
 * header for the security posture. The steps below are STRICTLY ORDERED and the
 * executor is the LAST, CONDITIONAL step.
 */
export async function requestPurchase(
  input: RequestPurchaseInput,
): Promise<RequestPurchaseResult> {
  const {
    request,
    kernel,
    kernelId,
    factSource,
    db,
    executor,
    idempotencyKey,
    attestationPresent = false,
  } =
    input;

  // 1. Structural guard on the untrusted request. Invalid → policy_error, no execution.
  if (!isSpendRequest(request)) {
    return makeResult({
      status: "policy_error",
      message: "Invalid spend request: rejected before evaluation.",
      requestId:
        typeof (request as SpendRequest | undefined)?.invoiceRef === "string"
          ? (request as SpendRequest).invoiceRef!
          : "",
    });
  }

  const earlyRequestId = fallbackRequestId(request);

  // 2. Assemble AUTHORITATIVE facts. Any throw → policy_error, no execution.
  let facts: Facts;
  try {
    const authoritative = await factSource.contextFor({ request, attestationPresent });
    facts = translateToFacts(request, authoritative);
  } catch {
    return makeResult({
      status: "policy_error",
      message: "Could not assemble authoritative facts for the request.",
      requestId: earlyRequestId,
    });
  }

  // 3. Evaluate policy via the INJECTED kernel (no policy logic here).
  //    Throw or a malformed decision → policy_error, no execution.
  let decision: Decision;
  try {
    const raw = kernel.evaluate(facts);
    if (!isValidDecision(raw)) {
      return makeResult({
        status: "policy_error",
        message: "Policy evaluation returned a malformed decision.",
        requestId: facts.request_id || earlyRequestId,
      });
    }
    decision = raw;
  } catch {
    return makeResult({
      status: "policy_error",
      message: "Policy evaluation failed.",
      requestId: facts.request_id || earlyRequestId,
    });
  }

  // 4–6. Deterministic decision id (or the caller's idempotency key), trusted
  //      provenance, and the tamper-evident proof. These are pure CONSTRUCTION
  //      steps: any throw (e.g. a fact that cannot be canonicalized, or an invalid
  //      provenance graph) is a fail-closed `policy_error` with NO execution.
  //      `decisionId` is surfaced when it was computed before the failure.
  let decisionId: string | null = null;
  let proof: LedgerProof;
  try {
    // 4. Deterministic, content-addressed id (not process-local). Same content →
    //    same id → idempotent retries collapse to a ledger no-op.
    decisionId =
      idempotencyKey ??
      "dec_" +
        sha256OfJson({
          request: request as unknown as Json,
          facts: facts as unknown as Json,
          decision: decision as unknown as Json,
          kernelId: (kernelId ?? null) as Json,
        });

    // 5. Derive trusted provenance (never agent-supplied). Optional nodes appear
    //    ONLY when genuinely provided; map to the builder's field names.
    const provenance = buildDecisionProvenance({
      request,
      decision,
      facts,
      kernelId,
      ...(input.toolCallId !== undefined
        ? { toolCall: { id: input.toolCallId } }
        : {}),
      ...(input.taskId !== undefined ? { taskChainId: input.taskId } : {}),
    });

    // 6. Build the tamper-evident proof. Attestation status is HONEST: never "verified".
    proof = buildProof({
      decisionId,
      request,
      decision,
      facts,
      policyDigest: policyDigest(facts),
      kernelId,
      attestation: {
        status: facts.attestation_present ? "present_unverified" : "absent",
      },
      provenance,
      producedAt: input.producedAt,
    });
  } catch {
    return makeResult({
      status: "policy_error",
      decisionId,
      outcome: decision.decision,
      firedRules: decision.firedRules,
      reasons: decision.reasons,
      message: "Could not build the decision proof.",
      requestId: facts.request_id || (decisionId ?? earlyRequestId),
    });
  }

  const requestId = facts.request_id || decisionId;

  // Shared partial for every decision-bearing return below.
  const decided = {
    decisionId,
    outcome: decision.decision,
    firedRules: decision.firedRules,
    reasons: decision.reasons,
    requestId,
  } as const;

  // 7. Persist decision + proof atomically. Conflict or any throw → audit_error, no execution.
  try {
    recordDecision(db, {
      decisionId,
      request,
      facts,
      decision,
      kernelId,
      proof,
    });
  } catch (err) {
    const conflict = err instanceof DecisionConflictError;
    return makeResult({
      ...decided,
      status: "audit_error",
      proofId: proof.proofId,
      message: conflict
        ? "Audit conflict: this decision id already exists with different content; refusing to execute."
        : "Audit write failed; refusing to execute.",
    });
  }

  // 8. INDEPENDENT re-verify BEFORE any execution: re-read the persisted record and
  //    recompute the proof. Not verified → audit_error, no execution.
  const record = getDecision(db, decisionId);
  const verification = verifyDecisionProof(record ?? { proof: null });
  if (!verification.proofVerified) {
    return makeResult({
      ...decided,
      status: "audit_error",
      proofId: proof.proofId,
      message: "Persisted proof did not independently verify; refusing to execute.",
    });
  }

  // 9. DENY → return without ever touching the executor.
  if (decision.decision === "deny") {
    return makeResult({
      ...decided,
      status: "denied",
      proofId: proof.proofId,
      proofVerified: true,
      executed: false,
      receipt: null,
      message:
        decision.reasons.length > 0
          ? `Payment denied: ${decision.reasons.join("; ")}`
          : "Payment denied by policy.",
    });
  }

  // 10. Allowed + persisted + verified → execute (LAST, CONDITIONAL). Throw or a
  //     failed receipt → executor_error; the decision stays persisted regardless.
  let receipt: ExecutorReceipt;
  try {
    receipt = await executor.execute({
      decisionId,
      idempotencyKey: decisionId,
      request,
    });
  } catch {
    return makeResult({
      ...decided,
      status: "executor_error",
      proofId: proof.proofId,
      proofVerified: true,
      executed: false,
      message: "Decision allowed and persisted, but payment execution threw.",
    });
  }

  // Record the execution receipt (settled OR failed) to the audit trail so the
  // dashboard can show what the executor actually DID, not just what was decided.
  persistExecution(db, decisionId, receipt);

  if (receipt.status === "failed") {
    return makeResult({
      ...decided,
      status: "executor_error",
      proofId: proof.proofId,
      proofVerified: true,
      executed: false,
      receipt,
      message: `Decision allowed and persisted, but payment failed (${receipt.provider}).`,
    });
  }

  return makeResult({
    ...decided,
    status: "allowed",
    proofId: proof.proofId,
    proofVerified: true,
    executed: true,
    receipt,
    message: `Payment settled: ${request.amount} ${request.currency} to ${request.vendorId} (${receipt.receiptId})`,
  });
}

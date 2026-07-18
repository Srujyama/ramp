/**
 * @ramp/client — the typed agent SDK
 *
 * "Build a spending agent on the gate" in a few lines. This composes the exact
 * same pieces the PreToolUse hook and the MCP tool compose — attestation
 * verification, the fail-closed purchase lifecycle, the read-only fact source —
 * behind one typed object, so an agent author does not have to wire six packages
 * to make a provable payment.
 *
 *   import { createRampClient } from "@ramp/client";
 *   import { demoAgentKeypair } from "@ramp/attestation";
 *   // The agent's OWN private key — pay() signs every request's identity core
 *   // with it, and the gate verifies against the registry's public key.
 *   const ramp = createRampClient({ identityKey: demoAgentKeypair("agent_47").privateKey });
 *   const r = await ramp.pay({
 *     vendorId: "acme_corp", amount: 340, currency: "USD",
 *     category: "office_supplies", requestingAgent: "agent_47",
 *     invoiceDocument, attestation,
 *   });
 *   if (r.status === "allowed") { /* paid *\/ }
 *   else if (r.status === "escalated") { /* wait for ramp.approval(r.decisionId) *\/ }
 *   else { /* denied — r.reasons says why *\/ }
 *
 * IMPORTANT — WHAT THIS IS NOT. The SDK is a CONVENIENCE, not the enforcement
 * boundary. The non-bypassable gate is the PreToolUse hook; the SDK reuses the
 * same lifecycle so a payment made through it is judged identically, but an agent
 * that skips the SDK and calls a raw payment tool is still caught by the hook.
 * The SDK makes the honest path easy; it does not make the dishonest path
 * possible. It runs the SAME `verifyAttestation` and the SAME `requestPurchase`
 * as everything else — one verifier, one lifecycle, no second opinion.
 */
import { getKernel } from "@ramp/gate";
import {
  openLedgerStrict,
  openLedger,
  closeLedger,
  LedgerFactSource,
  requestPurchase,
  simulate,
  approvalFor,
  listDecisions,
  type LedgerDb,
  type RequestPurchaseResult,
  type ExecutorRequest,
  type SettlementRecord,
  type PaymentExecutor,
} from "@ramp/ledger";
import {
  verifyAttestation,
  demoKeyring,
  signAttestation,
  digestInvoice,
  demoNotaryPrivateKey,
  DEMO_NOTARY_KEY_ID,
  ATTESTATION_VERSION,
  signSpendRequest,
  verifyAgentIdentity,
} from "@ramp/attestation";
import { createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { SpendRequest } from "@ramp/shared";

/**
 * A deterministic sandbox executor — settles a fake settlement record, moves no real money.
 *
 * The SDK ships its own rather than importing one so `@ramp/client` does not
 * depend on the MCP app. A real deployment injects a live executor via
 * `createRampClient({ executor })`; the lifecycle is identical.
 */
function sandboxExecutor(): PaymentExecutor {
  return {
    execute(req: ExecutorRequest): SettlementRecord {
      return {
        settlementId: `rcpt_${req.decisionId.slice(0, 8)}`,
        executionId: `exec_${req.decisionId.slice(0, 8)}`,
        status: "settled",
        provider: "sandbox",
      };
    },
  };
}

/** Options for {@link createRampClient}. */
export interface RampClientOptions {
  /** Ledger path, or `:memory:`. Defaults to the standard on-disk ledger. */
  readonly dbPath?: string;
  /**
   * Open the ledger permissively (auto-provision if empty). Defaults to STRICT —
   * the enforcement posture. Set true only for a throwaway `:memory:` client in a
   * test, where you want the schema created for you.
   */
  readonly provision?: boolean;
  /** Inject a real payment executor. Defaults to the sandbox. */
  readonly executor?: PaymentExecutor;
  /**
   * The AGENT'S Ed25519 private key (PKCS#8 PEM or a KeyObject). When set,
   * `pay()` signs every request's identity core automatically
   * (@ramp/attestation's `signSpendRequest`), so the honest path needs no
   * manual signing. Without it — and without a pre-signed `identity` on the
   * request — the gate denies on `deny/unauthenticated_agent`, because an
   * unsigned request proves nothing about who sent it.
   *
   * This key never reaches the ledger or the verifier: the SDK signs with it,
   * and the gate checks against the PUBLIC key the agent registry holds. Demo
   * agents: `demoAgentKeypair(agentId).privateKey` from @ramp/attestation.
   */
  readonly identityKey?: string | KeyObject;
}

/** A budget summary for one agent (read-only). */
export interface BudgetSummary {
  readonly agent: string;
  readonly spentToday: number;
  readonly dailyLimit: number;
  readonly remainingToday: number;
  readonly perTxnCap: number;
  readonly escalationThreshold: number;
  /** Largest amount that would settle UNATTENDED right now. */
  readonly maxUnattendedNow: number;
  readonly currency: string;
}

/** The typed client. Close it when done (or use `withRampClient`). */
export interface RampClient {
  /**
   * Make a provable payment. Verifies the attestation, then drives the fail-closed
   * lifecycle. Returns the full result; `status` is `allowed` | `denied` |
   * `escalated` | `policy_error` | `audit_error` | `executor_error`.
   */
  pay(request: SpendRequest): Promise<RequestPurchaseResult>;
  /** Preview the outcome WITHOUT spending (real kernel, zero side effects). */
  preview(input: {
    requestingAgent: string;
    vendorId: string;
    amount: number;
    category: string;
    attested?: boolean;
    identityVerified?: boolean;
  }): {
    outcome: string;
    firedRules: readonly string[];
    reasons: readonly string[];
    assumedAttested: boolean;
    assumedIdentityVerified: boolean;
  };
  /** How much room an agent has left today. Throws for an unknown agent (fail-closed). */
  budget(agent: string): BudgetSummary;
  /** Whether a human has resolved a held decision. `null` if unresolved. */
  approval(decisionId: string): { verdict: string; approvedBy: string } | null;
  /** Recent decisions from the append-only log. */
  decisions(limit?: number): ReturnType<typeof listDecisions>["decisions"];
  /**
   * DEMO/TEST convenience: mint a valid attestation for a request using the demo
   * notary, so the happy path is one call. Never use in production — the demo
   * notary key is public (see @ramp/attestation). Returns a `SpendRequest` with
   * `invoiceDocument` + `attestation` filled in.
   */
  withDemoAttestation(
    request: SpendRequest & { serverDomain: string; invoiceDocument?: string },
  ): SpendRequest;
  /** Release the ledger handle. */
  close(): void;
}

/** Open a typed client over the ledger. Remember to `close()`. */
export function createRampClient(opts: RampClientOptions = {}): RampClient {
  const db: LedgerDb = opts.provision
    ? openLedger(opts.dbPath, { provisionIfEmpty: true, seed: true })
    : openLedgerStrict(opts.dbPath);
  const factSource = new LedgerFactSource(db);
  const executor = opts.executor ?? sandboxExecutor();
  const { kind: kernelId, kernel } = getKernel();
  // Normalise the identity key ONCE. A bad PEM fails loudly here, at client
  // construction — a signing key that cannot sign is a configuration error, not
  // a per-payment surprise.
  const identityKey: KeyObject | undefined =
    opts.identityKey === undefined
      ? undefined
      : typeof opts.identityKey === "string"
        ? createPrivateKey(opts.identityKey)
        : opts.identityKey;

  return {
    async pay(request: SpendRequest): Promise<RequestPurchaseResult> {
      // Sign the identity core with the agent's key, unless the caller already
      // attached a signature (a pre-signed request is respected verbatim — the
      // SDK must not re-sign what another key holder signed).
      const signed: SpendRequest =
        identityKey !== undefined && request.identity === undefined
          ? signSpendRequest(request, identityKey)
          : request;

      // Verify the attestation the SAME way the hook does — one verifier.
      const registeredDomain = safe(() => factSource.getVendorDomain(signed.vendorId), null);
      const invoiceDigest = digestInvoice(
        typeof signed.invoiceDocument === "string" ? signed.invoiceDocument : "",
      );
      const att = verifyAttestation(signed.attestation, {
        keyring: demoKeyring(),
        expect: {
          invoiceDigest,
          registeredDomain,
          amount: signed.amount,
          currency: signed.currency,
        },
        now: Date.now(),
      });

      // Verify the identity the SAME way the gates do: signature vs the
      // REGISTRY's key. The SDK signing above is a convenience; this check is
      // the judgement, and it is identical whether the SDK signed or the caller
      // did. Signing with an unregistered key still denies.
      const agentKeyPem = safe(
        () => factSource.getAgentPublicKey(signed.requestingAgent),
        null,
      );
      const agentIdentityVerified =
        agentKeyPem !== null && verifyAgentIdentity(signed, agentKeyPem);

      return requestPurchase({
        request: signed,
        kernel,
        kernelId,
        factSource,
        db,
        executor,
        attestationPresent: att.verified === true,
        agentIdentityVerified,
      });
    },

    preview(input) {
      const r = simulate(
        db,
        {
          agent: input.requestingAgent,
          vendor: input.vendorId,
          amount: input.amount,
          category: input.category,
          attested: input.attested,
          identityVerified: input.identityVerified,
        },
        kernel,
      );
      return {
        outcome: r.outcome,
        firedRules: r.firedRules,
        reasons: r.reasons,
        assumedAttested: r.assumedAttested,
        assumedIdentityVerified: r.assumedIdentityVerified,
      };
    },

    budget(agent: string): BudgetSummary {
      const spent = factSource.getDailyTotalSoFar(agent); // throws on unknown agent
      const limits = factSource.getLimits();
      const remaining = Math.max(0, limits.dailyLimit - spent);
      return {
        agent,
        spentToday: spent,
        dailyLimit: limits.dailyLimit,
        remainingToday: remaining,
        perTxnCap: limits.perTxnCap,
        escalationThreshold: limits.escalationThreshold,
        maxUnattendedNow: Math.max(
          0,
          Math.min(limits.perTxnCap, limits.escalationThreshold, remaining),
        ),
        currency: limits.currency,
      };
    },

    approval(decisionId: string) {
      const a = approvalFor(db, decisionId);
      return a ? { verdict: a.verdict, approvedBy: a.approvedBy } : null;
    },

    decisions(limit = 10) {
      return listDecisions(db, { limit }).decisions;
    },

    withDemoAttestation(request) {
      const invoiceDocument =
        request.invoiceDocument ??
        `INVOICE ${request.vendorId} ${request.category} ${request.amount} ${request.currency}\n`;
      const attestation = signAttestation(
        {
          version: ATTESTATION_VERSION,
          serverDomain: request.serverDomain,
          invoiceDigest: digestInvoice(invoiceDocument),
          transcriptCommitment: `tc_${digestInvoice(request.serverDomain).slice(0, 20)}`,
          notarizedAt: new Date().toISOString(),
          amount: request.amount,
          currency: request.currency,
          invoiceRef: request.invoiceRef ?? "inv_sdk",
        },
        demoNotaryPrivateKey(),
        DEMO_NOTARY_KEY_ID,
      );
      const { serverDomain: _omit, ...rest } = request;
      return { ...rest, invoiceDocument, attestation };
    },

    close() {
      closeLedger(db);
    },
  };
}

/** Run `fn` with a client, closing it afterward even on throw. */
export async function withRampClient<T>(
  opts: RampClientOptions,
  fn: (ramp: RampClient) => Promise<T> | T,
): Promise<T> {
  const ramp = createRampClient(opts);
  try {
    return await fn(ramp);
  } finally {
    ramp.close();
  }
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

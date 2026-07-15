/**
 * @ramp/payments-mcp — self-enforcing MCP server
 *
 * Exposes a single tool, `pay_vendor` (full MCP name `mcp__payments__pay_vendor`),
 * over stdio using `@modelcontextprotocol/sdk`. The tool's input schema mirrors the
 * `SpendRequest` shape from `@ramp/shared` (plus optional UX/provenance hints).
 *
 * THIS TOOL ENFORCES POLICY ITSELF. It drives the shared, fail-closed purchase
 * lifecycle via `requestPurchase(@ramp/ledger)`:
 *
 *     policy evaluate -> build provenance -> build proof -> persist decision
 *       -> INDEPENDENTLY re-verify the persisted proof -> (only then) execute
 *
 * Money moves ONLY on a decision that policy allowed, that was durably persisted,
 * and whose proof re-verified from the store. A deny (or any construction/audit
 * failure) short-circuits before the executor is ever touched. The executor here
 * is the SANDBOX executor — it settles a deterministic fake receipt and moves NO
 * real money and surfaces NO credentials.
 *
 * Honest note on defense-in-depth: under Claude Code the PreToolUse hook (matcher
 * `mcp__payments__.*`) ALSO evaluates the request against the kernel and can deny
 * it before this tool is ever invoked. That hook and this tool are two INDEPENDENT
 * gates over the same kernel — they are NOT correlated by a shared id, and neither
 * relies on the other. This tool is safe to call directly (no hook present) because
 * it enforces on its own; the hook is an extra, earlier line of defense.
 *
 * Runnable with `node dist/server.js` (after build) or `tsx src/server.ts`.
 */
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  verifyAttestation,
  demoKeyring,
  digestInvoice,
} from "@ramp/attestation";
import {
  requestPurchase,
  openLedger,
  closeLedger,
  LedgerFactSource,
  DEFAULT_DB_PATH,
} from "@ramp/ledger";
import type {
  LedgerDb,
  PaymentExecutor,
  RequestPurchaseInput,
  RequestPurchaseResult,
} from "@ramp/ledger";
import { getKernel } from "@ramp/gate";
import type { PolicyKernel } from "@ramp/shared";
import { isSpendRequest, type SpendRequest } from "@ramp/shared";
import { makeSandboxExecutor } from "./executor.js";
import {
  handleCheckBudget,
  handlePreviewPayment,
  handleCheckApproval,
  handleListDecisions,
  checkBudgetShape,
  previewPaymentShape,
  checkApprovalShape,
  listDecisionsShape,
} from "./agent-tools.js";

/**
 * Zod shape for the tool input. The first six fields are field-for-field identical
 * to `SpendRequest` (`@ramp/shared/spend-request`) — the only trusted policy inputs.
 * `reason`/`toolCallId`/`taskId` are OUT-OF-BAND hints:
 *   - `reason`  — human-readable narration for UX/audit only. It is NOT a policy
 *                 fact and is deliberately NOT fed into facts or the decision path.
 *   - `toolCallId`/`taskId` — trusted task/tool-call identifiers, forwarded to the
 *                 decision PROVENANCE only when genuinely present.
 */
const payVendorInputShape = {
  vendorId: z
    .string()
    .describe('Vendor id the agent wants to pay, e.g. "acme_corp". Registry key.'),
  amount: z
    .number()
    .int()
    .nonnegative()
    .describe("Requested amount in whole currency units (non-negative integer)."),
  currency: z.string().describe('ISO 4217 currency code, e.g. "USD".'),
  category: z
    .string()
    .describe('Spend category asserted by the caller, e.g. "office_supplies".'),
  invoiceRef: z
    .string()
    .optional()
    .describe('Reference to the invoice/attestation, e.g. "inv_2026_07_0043". Optional.'),
  requestingAgent: z
    .string()
    .describe('Agent id making the request, e.g. "agent_47". Ledger key.'),
  invoiceDocument: z
    .string()
    .optional()
    .describe(
      "The invoice document exactly as the vendor served it. Untrusted prose: it " +
        "is quarantined on arrival and never interpreted — its bytes exist only to " +
        "be hashed and checked against the attestation's invoiceDigest.",
    ),
  attestation: z
    .unknown()
    .optional()
    .describe(
      "A TLSNotary-style attestation over invoiceDocument, as minted by the notary. " +
        "Presenting one grants nothing: the PreToolUse hook verifies the signature " +
        "against a trusted keyring and checks it binds to THIS payment (invoice " +
        "digest, the vendor's registered domain, amount, currency, freshness). " +
        "Without a VERIFIED attestation the gate denies (deny/attestation_invalid).",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Human-readable narration for UX/audit only. NOT a policy fact — ignored by the decision path.",
    ),
  toolCallId: z
    .string()
    .optional()
    .describe("Trusted tool-call id. Forwarded to decision provenance when present."),
  taskId: z
    .string()
    .optional()
    .describe("Trusted task id. Forwarded to decision provenance when present."),
} as const;

/**
 * Compiled object schema for the tool input. Exported so tests can assert the
 * validation boundary (int / nonnegative / required fields) that the MCP SDK
 * applies before the handler ever runs — `isSpendRequest` alone does NOT enforce
 * integer/nonnegative amounts, that guarantee lives here.
 */
export const payVendorInputSchema = z.object(payVendorInputShape);

/** Parsed tool arguments (post zod validation). */
type PayVendorArgs = {
  vendorId: string;
  amount: number;
  currency: string;
  category: string;
  invoiceRef?: string;
  requestingAgent: string;
  /** Untrusted invoice prose. Only ever hashed — never interpreted. */
  invoiceDocument?: string;
  /** Untrusted attestation blob. Verified here; presenting one grants nothing. */
  attestation?: unknown;
  reason?: string;
  toolCallId?: string;
  taskId?: string;
};

/**
 * The vendor's REGISTERED domain, or null if it cannot be read.
 *
 * Fails closed by construction, and the null is load-bearing rather than lazy:
 * `verifyAttestation` treats a null registered domain as "no domain to bind to",
 * so no attestation can verify, so `attestation_present` is false, so D6 denies.
 * An unreadable registry therefore blocks the payment — it never waves it
 * through.
 *
 * The catch exists because this runs BEFORE the purchase lifecycle opens its own
 * transaction, and a caller may legitimately inject a fact source that is not
 * backed by a live DB (the tool's `openDb` is an injectable seam). Letting the
 * read throw here would turn a fail-closed deny into an unhandled crash, which is
 * a worse failure mode for the same outcome. If the DB really is broken, the
 * lifecycle below independently fails on facts and returns `policy_error` with no
 * execution — so nothing is paid on the strength of this swallow.
 */
function registeredDomainOrNull(
  factSource: LedgerFactSource,
  vendorId: string,
): string | null {
  try {
    return factSource.getVendorDomain(vendorId);
  } catch {
    return null;
  }
}

/** A single MCP text-content block. */
interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * The (structured) tool result this handler returns to the MCP client. The index
 * signature keeps it structurally assignable to the SDK's `CallToolResult`.
 */
interface PayVendorResult {
  readonly [key: string]: unknown;
  readonly isError?: boolean;
  readonly content: TextContent[];
  readonly structuredContent: Record<string, unknown>;
}

/**
 * Injectable dependencies. Production defaults wire the exact frozen lifecycle;
 * tests override individual seams (e.g. an in-memory seeded ledger, a failing
 * executor, or a stubbed `runPurchase`) WITHOUT changing the default code path.
 */
export interface PayVendorDeps {
  /** Open a ledger handle. Default: on-disk `openLedger()`. */
  readonly openDb?: () => LedgerDb;
  /** Resolve the active policy kernel + its id. Default: `getKernel()`. */
  readonly getKernel?: () => { kind: string; kernel: PolicyKernel };
  /** Build the payment executor. Default: `makeSandboxExecutor()`. */
  readonly makeExecutor?: () => PaymentExecutor;
  /** Run the purchase lifecycle. Default: `requestPurchase`. */
  readonly runPurchase?: (
    input: RequestPurchaseInput,
  ) => Promise<RequestPurchaseResult>;
}

/**
 * Sandbox failure seam for demos/tests. `RAMP_FAIL_VENDORS` is a comma-separated
 * list of vendorIds the sandbox executor should return a `failed` receipt for.
 * This lets a LIVE stdio server deterministically exercise the `executor_error`
 * path (allowed + persisted + verified, then payment fails) with no real
 * provider and no secret. Unset/empty → the sandbox always settles. It can only
 * make an allowed payment FAIL; it can never turn a deny into a payment.
 */
function sandboxFailVendorIds(): readonly string[] {
  return (process.env.RAMP_FAIL_VENDORS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DEFAULT_DEPS: Required<PayVendorDeps> = {
  // Honor RAMP_DB_PATH so the server, the read-only bridge, and the verify-proof
  // CLI all read/write the SAME ledger (as the client docs promise). Without this
  // the server silently wrote ./ramp.db (cwd-relative) while the bridge read
  // $RAMP_DB_PATH — so the dashboard never saw the server's decisions.
  openDb: () => openLedger(process.env.RAMP_DB_PATH || DEFAULT_DB_PATH),
  getKernel,
  makeExecutor: () => makeSandboxExecutor({ failVendorIds: sandboxFailVendorIds() }),
  runPurchase: requestPurchase,
};

/** The four non-happy statuses that should be surfaced as MCP tool errors. */
const ERROR_STATUSES = new Set(["policy_error", "audit_error", "executor_error"]);

/** Wrap a structuredContent object into the MCP tool-result envelope. */
function toResult(
  structuredContent: Record<string, unknown>,
  isError: boolean,
): PayVendorResult {
  const envelope: PayVendorResult = {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
  return isError ? { ...envelope, isError: true } : envelope;
}

/**
 * The `pay_vendor` handler. Builds a `SpendRequest` from the six trusted fields,
 * re-guards it (defense in depth), drives `requestPurchase`, and maps the result
 * status to a stable structuredContent schema. NEVER surfaces secrets/credentials:
 * only whitelisted, non-sensitive fields are copied into the response.
 *
 * Exported so tests can exercise the real handler directly against a seeded ledger.
 */
export async function handlePayVendor(
  args: PayVendorArgs,
  deps: PayVendorDeps = {},
): Promise<PayVendorResult> {
  const { openDb, getKernel: resolveKernel, makeExecutor, runPurchase } = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  // Build the SpendRequest from ONLY the six trusted policy fields. `reason` is
  // deliberately excluded — it is UX narration, not a fact.
  const request: SpendRequest = {
    vendorId: args.vendorId,
    amount: args.amount,
    currency: args.currency,
    category: args.category,
    requestingAgent: args.requestingAgent,
    ...(args.invoiceRef !== undefined ? { invoiceRef: args.invoiceRef } : {}),
  };

  // Defense in depth: the SDK already validated the zod shape, but re-check with
  // the shared runtime guard before anything touches the ledger. Fail closed.
  if (!isSpendRequest(request)) {
    return toResult(
      {
        status: "policy_error",
        decisionId: null,
        message:
          "Invalid pay_vendor input: does not match the SpendRequest shape.",
      },
      true,
    );
  }

  const db = openDb();
  try {
    const { kind, kernel } = resolveKernel();
    const factSource = new LedgerFactSource(db);
    const executor = makeExecutor();

    // PILLAR 4. Verify the attestation before the lifecycle evaluates policy.
    //
    // This calls the SAME `verifyAttestation` the PreToolUse hook calls — one
    // verifier, two call sites, no second opinion. The verdict is a boolean that
    // becomes the `attestation_present` fact; a missing/forged/expired/unbound
    // attestation all reduce to `false`, and D6 denies on false.
    //
    // The vendor's registered domain comes from the LEDGER, never the
    // attestation: an attestation proves "these bytes came from domain X", and
    // only the registry can say whether X is who we think this vendor is.
    const attestationResult = verifyAttestation(args.attestation, {
      keyring: demoKeyring(),
      expect: {
        invoiceDigest: digestInvoice(args.invoiceDocument ?? ""),
        registeredDomain: registeredDomainOrNull(factSource, request.vendorId),
        amount: request.amount,
        currency: request.currency,
      },
      now: Date.now(),
    });

    const r = await runPurchase({
      request,
      kernel,
      kernelId: kind,
      factSource,
      db,
      executor,
      attestationPresent: attestationResult.verified === true,
      // Forwarded to provenance only when genuinely present.
      toolCallId: args.toolCallId,
      taskId: args.taskId,
    });

    return mapResult(r, request);
  } finally {
    // Always release the handle, even on throw.
    closeLedger(db);
  }
}

/**
 * Map a `RequestPurchaseResult` to the stable, whitelisted structuredContent
 * schema. Each branch copies only non-sensitive fields — the executor receipt
 * carries no secrets by contract, and we never spread it wholesale.
 */
function mapResult(
  r: RequestPurchaseResult,
  request: SpendRequest,
): PayVendorResult {
  if (r.status === "allowed") {
    const receipt = r.receipt;
    return toResult(
      {
        status: "allowed",
        decisionId: r.decisionId,
        requestId: r.requestId,
        // execution-scoped id — NOT a policy-correlation id. Use decisionId/requestId
        // to correlate a payment with its policy decision; this ties it to the run.
        executionId: receipt ? receipt.executionId : null,
        vendor: request.vendorId,
        amount: request.amount,
        currency: request.currency,
        policyOutcome: "allow",
        firedRules: r.firedRules,
        proofId: r.proofId,
        proofVerified: r.proofVerified,
        paymentStatus: receipt ? receipt.status : null,
        receiptId: receipt ? receipt.receiptId : null,
        message: r.message,
      },
      false,
    );
  }

  if (r.status === "denied") {
    return toResult(
      {
        status: "denied",
        decisionId: r.decisionId,
        policyOutcome: "deny",
        firedRules: r.firedRules,
        proofId: r.proofId,
        proofVerified: r.proofVerified,
        reason: r.reasons.join("; "),
        message: r.message,
      },
      false,
    );
  }

  // policy_error | audit_error | executor_error — distinguished by `status`.
  return toResult(
    {
      status: r.status,
      decisionId: r.decisionId,
      message: r.message,
    },
    ERROR_STATUSES.has(r.status),
  );
}

/**
 * Assemble the MCP server and register the single enforcing tool. Exported so
 * tests can construct a server (and, optionally, inject deps) without spawning a
 * transport. The zero-arg call (`createServer()`) wires the production lifecycle.
 */
export function createServer(deps: PayVendorDeps = {}): McpServer {
  const server = new McpServer({
    name: "ramp-payments-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "pay_vendor",
    {
      title: "Pay Vendor",
      description:
        "Request a vendor payment. Self-enforcing: evaluates policy, persists a " +
        "tamper-evident proof, independently re-verifies it, and only then settles " +
        "a SANDBOX (fake, no real money) payment. Denies and failures never pay. " +
        "Returns a structured receipt on allow or a structured denial otherwise.",
      inputSchema: payVendorInputShape,
    },
    async (args) => handlePayVendor(args as PayVendorArgs, deps),
  );

  // ---- the agent's READ-ONLY tools ---------------------------------------
  //
  // Every one of these is a pure read. There is deliberately no tool that
  // approves an escalation: the agent that wanted the money would grant itself
  // permission and the audit trail would show a human-in-the-loop that never had
  // a human in it. Approving is `pnpm approve` — a person at a terminal. The
  // separation IS the control; see agent-tools.ts.
  const withDb = <A,>(fn: (a: A, db: LedgerDb) => unknown) => async (args: unknown) => {
    const db = (deps.openDb ?? DEFAULT_DEPS.openDb)();
    try {
      return fn(args as A, db) as never;
    } finally {
      closeLedger(db);
    }
  };

  server.registerTool(
    "check_budget",
    {
      title: "Check Budget",
      description:
        "How much can this agent still spend today? Reports spend so far, the daily " +
        "limit, the per-transaction cap, the human-approval threshold, and the largest " +
        "amount that would settle UNATTENDED right now. Read-only: nothing is spent " +
        "and no decision is recorded.",
      inputSchema: checkBudgetShape,
    },
    withDb(handleCheckBudget),
  );

  server.registerTool(
    "preview_payment",
    {
      title: "Preview Payment",
      description:
        "What WOULD policy decide for this spend? Runs the real policy engine against " +
        "real authoritative facts and returns allow / escalate / deny with the rules " +
        "that fired. Read-only: nothing is spent, no decision recorded, no proof. " +
        "Assumes a valid attestation (a preview has no invoice) and says so.",
      inputSchema: previewPaymentShape,
    },
    withDb(handlePreviewPayment),
  );

  server.registerTool(
    "check_approval",
    {
      title: "Check Approval",
      description:
        "Has a human resolved this held payment yet? Returns the verdict if one exists. " +
        "READ-ONLY — you cannot approve your own escalation. A person must run " +
        "`pnpm approve`. You can wait for an answer; you cannot make one.",
      inputSchema: checkApprovalShape,
    },
    withDb(handleCheckApproval),
  );

  server.registerTool(
    "list_decisions",
    {
      title: "List Decisions",
      description:
        "Recent decisions from the append-only audit log. Read-only.",
      inputSchema: listDecisionsShape,
    },
    withDb(handleListDecisions),
  );

  return server;
}

/** Boot the server over stdio. */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout here — stdout is the JSON-RPC channel. Diagnostics go to
  // stderr so they don't corrupt the protocol stream.
  process.stderr.write(
    "[ramp-payments-mcp] enforcing server ready on stdio " +
      "(tool: mcp__payments__pay_vendor). Self-enforcing via requestPurchase; " +
      "the PreToolUse hook is an independent pre-gate.\n",
  );
}

// Run only when executed directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`[ramp-payments-mcp] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

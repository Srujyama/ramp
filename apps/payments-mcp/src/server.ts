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
  requestPurchase,
  openLedger,
  closeLedger,
  LedgerFactSource,
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
  reason?: string;
  toolCallId?: string;
  taskId?: string;
};

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

const DEFAULT_DEPS: Required<PayVendorDeps> = {
  openDb: () => openLedger(),
  getKernel,
  makeExecutor: () => makeSandboxExecutor(),
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

    const r = await runPurchase({
      request,
      kernel,
      kernelId: kind,
      factSource,
      db,
      executor,
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

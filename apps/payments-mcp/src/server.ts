/**
 * @ramp/payments-mcp — stub MCP server
 *
 * Exposes a single tool, `pay_vendor` (full MCP name `mcp__payments__pay_vendor`),
 * over stdio using `@modelcontextprotocol/sdk`. The tool's input schema mirrors the
 * `SpendRequest` shape from `@ramp/shared`.
 *
 * THIS IS A STUB. It does NOT move money and it does NOT enforce policy — it never
 * calls the policy kernel. Enforcement is entirely out of band: the Claude Code
 * PreToolUse hook (matcher `mcp__payments__.*`) evaluates the request against the
 * kernel and can deny it BEFORE this tool is ever invoked. If the tool runs, the
 * hook already allowed it, so the tool simply returns a deterministic fake receipt.
 *
 * Runnable with `node dist/server.js` (after build) or `tsx src/server.ts`.
 */
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isSpendRequest, type SpendRequest } from "@ramp/shared";
import { makeFakeReceipt } from "./receipt.js";

/**
 * Zod shape for the tool input. Field-for-field identical to `SpendRequest`
 * (`@ramp/shared/spend-request`). Kept in lockstep with that interface — this is
 * the only place the camelCase tool_input is described for the MCP client.
 */
const payVendorInputShape = {
  vendorId: z
    .string()
    .describe('Vendor id the agent wants to pay, e.g. "acme_corp". Registry key.'),
  amount: z
    .number()
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
} as const;

/**
 * Assemble the MCP server and register the single stub tool. Exported so tests can
 * construct a server without spawning a transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "ramp-payments-mcp",
    version: "0.0.0",
  });

  server.registerTool(
    "pay_vendor",
    {
      title: "Pay Vendor (stub)",
      description:
        "Submit a vendor payment request. STUB: no funds move and this tool does " +
        "NOT enforce policy — the PreToolUse hook gates it out of band. Returns a " +
        "deterministic fake receipt.",
      inputSchema: payVendorInputShape,
    },
    async (args) => {
      // Defense-in-depth: the SDK already validated against the zod shape, but we
      // re-check with the shared runtime guard so the emitted object is a genuine
      // SpendRequest before we build a receipt from it.
      if (!isSpendRequest(args)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Invalid pay_vendor input: does not match the SpendRequest shape.",
            },
          ],
        };
      }

      const request: SpendRequest = args;
      const receipt = makeFakeReceipt(request);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(receipt, null, 2),
          },
        ],
        structuredContent: { ...receipt },
      };
    },
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
    "[ramp-payments-mcp] stub server ready on stdio " +
      "(tool: mcp__payments__pay_vendor). Enforcement is in the PreToolUse hook.\n",
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

/**
 * @ramp/payments-mcp — scripted end-to-end demo (no Claude Code required)
 *
 * Drives the REAL `dist/server.js` over the SAME MCP stdio transport Claude Code
 * uses (official SDK client), against a shared ledger DB, and prints the
 * allow / deny / executor-failure results. Every decision it produces is then
 * visible in the read-only bridge and the dashboard.
 *
 * Prereqs:  pnpm -r build
 * Usage:    RAMP_DB_PATH=/abs/path/ramp.db node apps/payments-mcp/scripts/demo.mjs
 *   - RAMP_DB_PATH is required (server + bridge + dashboard must share ONE file).
 *   - The DB is auto-provisioned + seeded on first open (agent_47 / acme_corp / …).
 *
 * Then, in two more terminals (same RAMP_DB_PATH):
 *   RAMP_DB_PATH=… pnpm --filter @ramp/ledger bridge
 *   pnpm --filter @ramp/dashboard dev      # → http://localhost:5173
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mintAttestation } from "../../../scripts/notary.mjs";

const dbPath = process.env.RAMP_DB_PATH;
if (!dbPath) {
  console.error("Set RAMP_DB_PATH to an absolute ledger path (shared with the bridge).");
  process.exit(2);
}
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

/** Run one pay_vendor call in a fresh server process (so failVendors can vary). */
async function call(label, args, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { RAMP_DB_PATH: dbPath, ...extraEnv },
  });
  const client = new Client({ name: "ramp-demo", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const res = await client.callTool({ name: "pay_vendor", arguments: args });
  await client.close();
  const sc = res.structuredContent;
  console.log(`\n### ${label}`);
  console.log(`  tools discovered : ${tools.map((t) => t.name).join(", ")}`);
  if (!sc) {
    console.log(`  status           : (no structuredContent — SDK-level error)`);
    console.log(`  message          : ${res.content?.[0]?.text ?? "(no content)"}`);
    return;
  }
  console.log(`  status           : ${sc.status}${res.isError ? "  (isError)" : ""}`);
  if (sc.firedRules) console.log(`  firedRules       : ${JSON.stringify(sc.firedRules)}`);
  console.log(`  proofVerified    : ${sc.proofVerified ?? "n/a"}`);
  console.log(`  paymentStatus    : ${sc.paymentStatus ?? "—"}`);
  console.log(`  receiptId        : ${sc.receiptId ?? "—"}`);
  console.log(`  message          : ${sc.message}`);
}

const base = { currency: "USD", category: "office_supplies", requestingAgent: "agent_47" };

// acme_corp's registered TLS domain (packages/ledger/sql/seed.sql) — attestations
// must be bound to this or D6 (attestation_present) denies them.
const ACME_DOMAIN = "acme.example.com";

/** Mint a fresh, genuinely-signed attestation for one invoice (freshness window is 15min). */
function attestFor({ amount, invoiceRef, currency = "USD" }) {
  const invoiceDocument =
    `ACME CORP\nInvoice ${invoiceRef}\nOffice supplies\nTotal: ${currency} ${amount}\n`;
  return {
    invoiceDocument,
    attestation: mintAttestation({
      invoiceDocument,
      serverDomain: ACME_DOMAIN,
      amount,
      currency,
      invoiceRef,
    }),
  };
}

// Seed's prior daily total for agent_47 is 1140 (packages/ledger/sql/seed.sql), and
// the daily limit is 1500 — headroom is shared across every vendor for that agent,
// so amounts below must add up to <= 360 across the whole run or later "allow"
// beats will trip deny/daily_limit_exceeded instead of demonstrating what they say.
await call("ALLOW — compliant purchase settles in the sandbox", {
  ...base, vendorId: "acme_corp", amount: 340, invoiceRef: "inv_demo_allow",
  ...attestFor({ amount: 340, invoiceRef: "inv_demo_allow" }),
});
await call("DENY — unverified vendor is blocked, no payment", {
  ...base, vendorId: "sketchy_llc", amount: 40, invoiceRef: "inv_demo_deny",
});
await call(
  "FAILURE — allowed, but the sandbox executor fails (executor_error)",
  {
    ...base, vendorId: "acme_corp", amount: 15, invoiceRef: "inv_demo_fail",
    ...attestFor({ amount: 15, invoiceRef: "inv_demo_fail" }),
  },
  { RAMP_FAIL_VENDORS: "acme_corp" },
);

console.log("\nDone. Start the bridge + dashboard (same RAMP_DB_PATH) to see these decisions.");

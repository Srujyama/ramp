#!/usr/bin/env node
/**
 * One-shot demo purchase, no LLM tool-call round trip — scripts/buy.mjs
 *
 *   pnpm buy -- --vendor acme_corp --amount 50 --category software
 *   pnpm buy -- --vendor acme_corp --amount 50 --category software --agent agent_47 \
 *               --ref inv_demo_001 --note "API access credits"
 *
 * Mints a genuine demo-notary attestation and drives the SAME lifecycle the
 * PreToolUse hook and `pay_vendor` use (`@ramp/client` -> `requestPurchase`), in
 * one process. Exists because an LLM-driven MCP client must GUESS how to
 * serialize `pay_vendor`'s `attestation` argument from the tool's JSON schema —
 * this script needs no schema guess, so it settles in well under a second
 * instead of a multi-turn mint-then-retry conversation.
 *
 * Exit code: 0 allowed, 3 escalated (held for human approval), 1 denied/error.
 */
import { createRampClient } from "@ramp/client";
import { openLedgerStrict, LedgerFactSource, closeLedger } from "@ramp/ledger";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const vendorId = args.vendor;
const amount = Number(args.amount);
const category = args.category;
const requestingAgent = args.agent ?? "agent_47";
const currency = args.currency ?? "USD";
const invoiceRef = args.ref ?? `inv_cli_${Date.now()}`;
const note = args.note ?? `${category ?? "purchase"}`;

if (!vendorId || !Number.isFinite(amount) || !category) {
  console.error(
    'Usage: pnpm buy -- --vendor <id> --amount <n> --category <cat> ' +
      '[--agent agent_47] [--currency USD] [--ref inv_x] [--note "..."]',
  );
  process.exit(2);
}

// The vendor's REGISTERED domain, read from the ledger (never guessed) — the
// attestation must bind to the SAME domain policy will check it against.
const domainDb = openLedgerStrict();
let serverDomain;
try {
  serverDomain = new LedgerFactSource(domainDb).getVendorDomain(vendorId);
} finally {
  closeLedger(domainDb);
}
if (!serverDomain) {
  console.error(
    `note: "${vendorId}" has no registered domain (unverified/unknown) — expect a deny.`,
  );
}

const ramp = createRampClient();
try {
  const req = ramp.withDemoAttestation({
    vendorId,
    amount,
    currency,
    category,
    requestingAgent,
    invoiceRef,
    serverDomain: serverDomain ?? "unregistered.invalid",
    invoiceDocument: `${vendorId.toUpperCase()}\nInvoice ${invoiceRef}\n${note}\nTotal: ${currency} ${amount}\n`,
  });
  const r = await ramp.pay(req);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.status === "allowed" ? 0 : r.status === "escalated" ? 3 : 1);
} finally {
  ramp.close();
}

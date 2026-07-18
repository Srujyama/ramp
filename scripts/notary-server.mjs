#!/usr/bin/env node
/**
 * The demo notary, as a SEPARATE PROCESS — scripts/notary-server.mjs
 *
 * scripts/notary.mjs is a library + CLI: call it in-process and you get a signed
 * attestation back immediately. That's fine for `pnpm demo`/tests, but it's the
 * wrong shape for a live pitch — if the same agent that's requesting the payment
 * also calls the code that signs the attestation, on the same screen, in the same
 * breath, it LOOKS like the payer is notarizing its own invoice. That's exactly
 * the self-attestation failure mode pillar 4 exists to rule out.
 *
 * This wraps the identical `mintAttestation`/`heroAttestation` logic behind a
 * plain HTTP server on its own port, started as its own process, in its own
 * terminal window. The agent (Codex, Claude Code, whatever) then does a plain
 * `curl`/fetch to an independent service to GET an attestation, then calls
 * `pay_vendor` with what it received — it never signs anything itself. That is
 * the correct shape of the real architecture: an independent notary witnesses
 * the invoice and hands back a signed statement; the payer only ever consumes it.
 *
 * Same caveat as notary.mjs itself, stated once more because it matters: this is
 * still NOT the TLSNotary MPC protocol (see packages/attestation/README.md). It's
 * a separate signer process instead of an in-process function call — a real
 * improvement in DEMO TOPOLOGY (there is now an actual process boundary and a
 * network hop between "requesting a payment" and "vouching for an invoice"), not
 * a claim that this became real TLSNotary. A production deployment would run
 * this as a genuinely independent, separately-operated service (or several, for
 * `verifyQuorum`), holding its key in an HSM.
 *
 * Usage:
 *   node scripts/notary-server.mjs                 # listen on :8790 (NOTARY_PORT to override)
 *
 * Endpoints:
 *   GET /health
 *   GET /attestation/hero
 *   GET /attestation?amount=70&category=office_supplies
 *       [&vendor-domain=acme.example.com&invoice-ref=inv_xyz&invoice-text=...&currency=USD]
 */
import { createServer } from "node:http";
import { mintAttestation, heroAttestation, HERO_INVOICE } from "./notary.mjs";

const PORT = Number(process.env.NOTARY_PORT ?? 8790);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2) + "\n");
}

function mintFromQuery(query) {
  const amount = Number(query.get("amount"));
  const category = query.get("category") ?? "office_supplies";
  const serverDomain = query.get("vendor-domain") ?? "acme.example.com";
  const invoiceRef = query.get("invoice-ref") ?? `inv_demo_${Date.now()}`;
  const currency = query.get("currency") ?? "USD";
  const invoiceDocument =
    query.get("invoice-text") ??
    `ACME CORP\nInvoice ${invoiceRef}\n${category.replace(/_/g, " ")}\nTotal: ${currency} ${amount}\n`;

  const attestation = mintAttestation({
    invoiceDocument,
    serverDomain,
    amount,
    currency,
    invoiceRef,
  });
  return { invoiceDocument, attestation };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method !== "GET") {
    json(res, 405, { error: "this notary only serves GET — it witnesses, it doesn't accept instructions" });
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      service: "demo-notary",
      note: "an independent signer process — not the agent, not the payer, not the vendor",
    });
    return;
  }

  if (url.pathname === "/attestation/hero") {
    json(res, 200, { invoiceDocument: HERO_INVOICE, attestation: heroAttestation() });
    return;
  }

  if (url.pathname === "/attestation") {
    if (!url.searchParams.has("amount") || Number.isNaN(Number(url.searchParams.get("amount")))) {
      json(res, 400, { error: "?amount=<number> is required" });
      return;
    }
    json(res, 200, mintFromQuery(url.searchParams));
    return;
  }

  json(res, 404, { error: "not found", routes: ["/health", "/attestation/hero", "/attestation?amount=..."] });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `[notary] independent demo notary listening on http://localhost:${PORT}\n` +
      `[notary]   GET /attestation/hero\n` +
      `[notary]   GET /attestation?amount=340&category=office_supplies&invoice-ref=inv_2026_07_0043\n` +
      `[notary] this process is NOT the agent and NOT the payer — it only witnesses and signs.`,
  );
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

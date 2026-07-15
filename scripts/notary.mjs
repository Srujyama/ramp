#!/usr/bin/env node
/**
 * The demo notary — scripts/notary.mjs
 *
 * Stands in for the party that watches a TLS session with a vendor and signs a
 * statement about what it saw. In the demo it is a local function; in reality it
 * is a separate service holding its key in an HSM.
 *
 * It exists so the demo can produce GENUINE signatures. Nothing here is faked:
 * `mintAttestation` really signs with the demo Ed25519 key, and the gate really
 * verifies it. That matters — a demo that stubs the crypto proves nothing about
 * the verifier, and the whole pitch is that we do not ask you to take our word.
 *
 * The interesting entry point is `mintDishonestAttestation`, which mints REAL
 * signatures over statements that are true about the wrong thing. That is the
 * spoof beat: an attacker with a real domain, real TLS, and a real notary. The
 * signature is perfect. The binding is what fails.
 *
 * Usage:
 *   node scripts/notary.mjs                       # print a hero attestation as JSON
 *   node scripts/notary.mjs --spoof               # a lookalike-domain attestation
 *   node scripts/notary.mjs --stale               # a genuine but expired one
 */
import {
  signAttestation,
  digestInvoice,
  demoNotaryPrivateKey,
  DEMO_NOTARY_KEY_ID,
  ATTESTATION_VERSION,
} from "@ramp/attestation";

/** The hero invoice document, as Acme's server would serve it. */
export const HERO_INVOICE =
  "ACME CORP\nInvoice inv_2026_07_0043\nOffice supplies — 12x ergonomic keyboard tray\nTotal: USD 340\n";

/**
 * Mint an honest attestation over an invoice.
 *
 * @param {object} opts
 * @param {string} opts.invoiceDocument the exact bytes the vendor served
 * @param {string} opts.serverDomain    the TLS server name observed
 * @param {number} opts.amount          amount as served (integer whole units)
 * @param {string} opts.currency        currency as served
 * @param {string} opts.invoiceRef      the vendor's own reference
 * @param {Date}   [opts.notarizedAt]   when the session was observed
 */
export function mintAttestation({
  invoiceDocument,
  serverDomain,
  amount,
  currency,
  invoiceRef,
  notarizedAt = new Date(),
}) {
  const statement = {
    version: ATTESTATION_VERSION,
    serverDomain,
    invoiceDigest: digestInvoice(invoiceDocument),
    // Opaque session handle. In real TLSNotary this is an MPC-produced
    // commitment; here it pins WHICH session was observed and is covered by the
    // signature, but proves nothing without the notary's honesty. Said plainly
    // in @ramp/attestation's README rather than dressed up.
    transcriptCommitment: `tc_${digestInvoice(serverDomain + invoiceRef).slice(0, 24)}`,
    notarizedAt: notarizedAt.toISOString(),
    amount,
    currency,
    invoiceRef,
  };
  return signAttestation(statement, demoNotaryPrivateKey(), DEMO_NOTARY_KEY_ID);
}

/** The honest attestation for the hero request: Acme, $340, right now. */
export function heroAttestation(notarizedAt = new Date()) {
  return mintAttestation({
    invoiceDocument: HERO_INVOICE,
    serverDomain: "acme.example.com",
    amount: 340,
    currency: "USD",
    invoiceRef: "inv_2026_07_0043",
    notarizedAt,
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const arg = process.argv[2];
  let att;
  if (arg === "--spoof") {
    att = mintAttestation({
      invoiceDocument: HERO_INVOICE,
      serverDomain: "acme-corp-billing.example", // real TLS, real notary, wrong company
      amount: 340,
      currency: "USD",
      invoiceRef: "inv_2026_07_0043",
    });
  } else if (arg === "--stale") {
    att = heroAttestation(new Date(Date.now() - 60 * 60 * 1000));
  } else {
    att = heroAttestation();
  }
  process.stdout.write(JSON.stringify(att, null, 2) + "\n");
}

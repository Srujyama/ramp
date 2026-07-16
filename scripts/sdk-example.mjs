#!/usr/bin/env node
/**
 * "Build a spending agent in ~15 lines" — scripts/sdk-example.mjs
 *   pnpm sdk-example
 *
 * A tiny agent that checks its budget, previews, then pays — all through the
 * typed SDK, all judged by the same gate as everything else.
 */
import { createRampClient } from "@ramp/client";

const ramp = createRampClient();
try {
  console.log("\n1. What's my budget?");
  const b = ramp.budget("agent_47");
  console.log(`   agent_47: ${b.spentToday}/${b.dailyLimit} spent, up to ${b.maxUnattendedNow} settles unattended.`);

  console.log("\n2. What WOULD a $340 office-supplies payment do?");
  const p = ramp.preview({ requestingAgent: "agent_47", vendorId: "acme_corp", amount: 340, category: "office_supplies" });
  console.log(`   -> ${p.outcome} (assumes a valid attestation).`);

  console.log("\n3. Pay it (with a demo attestation).");
  const req = ramp.withDemoAttestation({
    vendorId: "acme_corp", amount: 340, currency: "USD", category: "office_supplies",
    invoiceRef: "inv_sdk_example", requestingAgent: "agent_47", serverDomain: "acme.example.com",
  });
  const r = await ramp.pay(req);
  console.log(`   -> ${r.status}${r.receipt ? ` (receipt ${r.receipt.receiptId})` : ""}. Proof verified: ${r.proofVerified}.`);

  console.log("\n4. Try to overspend ($900, over the cap).");
  const r2 = await ramp.pay(ramp.withDemoAttestation({
    vendorId: "acme_corp", amount: 900, currency: "USD", category: "office_supplies",
    invoiceRef: "inv_sdk_over", requestingAgent: "agent_47", serverDomain: "acme.example.com",
  }));
  console.log(`   -> ${r2.status}: ${r2.reasons.join("; ")}\n`);
} finally {
  ramp.close();
}

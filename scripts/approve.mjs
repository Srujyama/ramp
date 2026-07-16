#!/usr/bin/env node
/**
 * The HUMAN channel — scripts/approve.mjs
 *
 *   pnpm approve                              # list what's being held
 *   pnpm approve <decisionId> --as alice      # approve, signing as alice
 *   pnpm approve <decisionId> --as bob --reject --note "wrong vendor"
 *
 * ============================================================================
 * WHY THIS IS A CLI AND NOT AN MCP TOOL
 * ============================================================================
 * This is the only thing that resolves an escalation, and it is deliberately
 * somewhere the agent cannot reach. If approving were an MCP tool, the agent that
 * requested the payment could grant it — and the audit trail would show a
 * human-in-the-loop that never had a human in it. The agent's tools READ approval
 * state; only a person here WRITES it. See packages/payments-mcp/agent-tools.ts.
 *
 * ============================================================================
 * `--as alice` IS NOT A CLAIM. IT SELECTS A KEY.
 * ============================================================================
 * This used to be `--by alice`, a string the ledger recorded verbatim — anyone
 * who ran the command could be "alice". Now `--as alice` selects alice's signing
 * KEY, and the ledger derives the identity from whichever registered key verifies.
 * You cannot be alice without alice's key.
 *
 * The honest limit: in the DEMO, alice's key is derived from a published constant
 * (see approver.ts) — so anyone can still be alice, by using the published key.
 * The MECHANISM is real; a real deployment holds each approver's private key in an
 * HSM or mints it from SSO, and then `--as alice` genuinely requires being alice,
 * with no change to any of this code.
 */
import {
  openLedgerStrict,
  closeLedger,
  resolveEscalation,
  listPendingEscalations,
  approvalFor,
  signApproval,
  demoApproverKeyring,
  demoApproverPrivateKey,
  DEMO_APPROVERS,
  ApprovalError,
} from "@ramp/ledger";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev === "--as" || prev === "--note");
});

const db = openLedgerStrict();
try {
  const decisionId = positional[0];

  if (!decisionId) {
    const pending = listPendingEscalations(db);
    if (pending.length === 0) {
      process.stdout.write("\nNothing is being held. No escalations await a human.\n\n");
      process.exit(0);
    }
    const who = DEMO_APPROVERS.map((a) => a.identity).join(", ");
    process.stdout.write(`\n${pending.length} payment(s) HELD, awaiting a human:\n\n`);
    for (const p of pending) {
      process.stdout.write(
        `  ${p.decisionId}\n` +
          `    ${p.agentId} -> ${p.vendorId}  ${p.amount} (${p.category})  ${p.ts}\n` +
          `    approve: pnpm approve ${p.decisionId} --as <${who}>\n` +
          `    reject:  pnpm approve ${p.decisionId} --as <${who}> --reject\n\n`,
      );
    }
    process.exit(0);
  }

  const identity = flag("as");
  if (!identity) {
    process.stderr.write(
      "--as <name> is required, and it selects a signing KEY, not a claim.\n" +
        `known demo approvers: ${DEMO_APPROVERS.map((a) => a.identity).join(", ")}\n`,
    );
    process.exit(2);
  }
  const entry = DEMO_APPROVERS.find((a) => a.identity === identity);
  if (!entry) {
    process.stderr.write(
      `no demo approver "${identity}". This is the demo keyring; a real one comes from ` +
        `your identity provider. Known: ${DEMO_APPROVERS.map((a) => a.identity).join(", ")}\n`,
    );
    process.exit(2);
  }

  // The digest the approver is signing for — read from the row, so the signature
  // binds to the exact facts under review.
  const row = db
    .prepare("SELECT content_digest AS d FROM decisions WHERE decision_id = ?")
    .get(decisionId);
  if (!row) {
    process.stderr.write(`no decision "${decisionId}".\n`);
    process.exit(1);
  }

  const verdict = has("reject") ? "rejected" : "approved";
  const approval = signApproval(
    {
      schema: "ramp/approval-v1",
      decisionId,
      verdict,
      factsDigest: row.d,
      note: flag("note") ?? null,
      at: new Date().toISOString(),
    },
    demoApproverPrivateKey(entry.keyId),
    entry.keyId,
  );

  const record = resolveEscalation(db, { approval, keyring: demoApproverKeyring() });

  process.stdout.write(
    `\n${verdict.toUpperCase()} ${record.decisionId}\n` +
      `  by:    ${record.approvedBy}  (established from the signing key, not the flag)\n` +
      `  bound: ${record.factsDigest.slice(0, 24)}…\n` +
      (record.note ? `  note:  ${record.note}\n` : "") +
      `\nThis approval was SIGNED by ${record.approvedBy}'s key, for THESE facts only.\n` +
      `It is not transferable to a different request, and nobody can record it under\n` +
      `a name they cannot sign for.\n\n` +
      `  payable now: ${approvalFor(db, decisionId)?.verdict === "approved" ? "yes" : "no"}\n\n`,
  );
} catch (err) {
  if (err instanceof ApprovalError) {
    process.stderr.write(`\n[${err.code}] ${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
} finally {
  closeLedger(db);
}

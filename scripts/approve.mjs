#!/usr/bin/env node
/**
 * The HUMAN channel — scripts/approve.mjs
 *
 *   pnpm approve                          # list what's being held
 *   pnpm approve <decisionId> --by alice  # approve it
 *   pnpm approve <decisionId> --by alice --reject --note "wrong vendor"
 *
 * ============================================================================
 * WHY THIS IS A CLI AND NOT AN MCP TOOL
 * ============================================================================
 * This is the only thing in the repo that can resolve an escalation, and it is
 * deliberately somewhere the agent cannot reach.
 *
 * If approving were an MCP tool, the agent that requested the payment could call
 * it. It would ask for permission, grant itself permission, and proceed — and
 * the audit trail would show a beautifully documented human-in-the-loop that
 * never had a human in it. That is strictly worse than having no escalation at
 * all, because it manufactures evidence of a control that does not exist.
 *
 * So: the agent's tools can READ approval state (`check_approval`). Only a person
 * at a terminal can WRITE it. The separation is the control — not the wording of
 * a tool description, which the model is free to ignore.
 *
 * WHAT THIS DOES NOT DO: authenticate you. `--by` is recorded, not verified;
 * anyone who can run this command can write any name. In a real deployment this
 * is an authenticated identity (SSO, a signed approval, a hardware token). The
 * ledger's shape does not change — it already treats the approver as data to be
 * recorded rather than a claim to be believed. It is a RECORD, not an
 * authentication, and calling it anything else would be the exact overclaim this
 * project exists to avoid.
 */
import {
  openLedgerStrict,
  closeLedger,
  resolveEscalation,
  listPendingEscalations,
  approvalFor,
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
  return !(prev === "--by" || prev === "--note");
});

const db = openLedgerStrict();
try {
  const decisionId = positional[0];

  // No id → show the queue. The default is deliberately read-only: the common
  // case is "what needs me?", not "approve something".
  if (!decisionId) {
    const pending = listPendingEscalations(db);
    if (pending.length === 0) {
      process.stdout.write("\nNothing is being held. No escalations await a human.\n\n");
      process.exit(0);
    }
    process.stdout.write(`\n${pending.length} payment(s) HELD, awaiting a human:\n\n`);
    for (const p of pending) {
      process.stdout.write(
        `  ${p.decisionId}\n` +
          `    ${p.agentId} -> ${p.vendorId}  ${p.amount} (${p.category})  ${p.ts}\n` +
          `    approve: pnpm approve ${p.decisionId} --by <you>\n` +
          `    reject:  pnpm approve ${p.decisionId} --by <you> --reject\n\n`,
      );
    }
    process.exit(0);
  }

  const approvedBy = flag("by");
  if (!approvedBy) {
    process.stderr.write(
      "--by <name> is required: an approval with nobody's name on it is not an approval.\n",
    );
    process.exit(2);
  }

  const verdict = has("reject") ? "rejected" : "approved";
  const record = resolveEscalation(db, {
    decisionId,
    verdict,
    approvedBy,
    note: flag("note"),
  });

  process.stdout.write(
    `\n${verdict.toUpperCase()} ${record.decisionId}\n` +
      `  by:    ${record.approvedBy}\n` +
      `  bound: ${record.factsDigest.slice(0, 24)}…\n` +
      (record.note ? `  note:  ${record.note}\n` : "") +
      `\nThis approval is valid for THESE facts only. If the request changes, it is\n` +
      `worthless — a $1 approval cannot be presented against a $50,000 payment.\n\n`,
  );
  // Show the resulting state, so the operator sees what the system now believes.
  const check = approvalFor(db, decisionId);
  process.stdout.write(
    `  payable now: ${check?.verdict === "approved" ? "yes" : "no"}\n\n`,
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

#!/usr/bin/env node
/**
 * Publish the chain head — scripts/head.mjs
 *
 *   pnpm head                      # print a signed checkpoint (publish this)
 *   pnpm head --out checkpoint.json   # write it somewhere
 *
 * Then, later:
 *   pnpm proof --checkpoint checkpoint.json
 *
 * ============================================================================
 * WHERE YOU PUT THE CHECKPOINT IS THE WHOLE FEATURE
 * ============================================================================
 * This command is trivial. The hard part is not code, and no amount of code can
 * do it for you: THE CHECKPOINT MUST LIVE SOMEWHERE THE LEDGER'S OPERATOR CANNOT
 * REWRITE.
 *
 * A checkpoint saved next to the database is worthless — whoever rewrites the chain
 * rewrites the checkpoint in the same breath. `--out checkpoint.json` is for DEMOS and
 * for piping; it is not a witness.
 *
 * Real witnesses, roughly in order of how much they cost you:
 *   - post it to a channel your customers/auditors read (a status page, a Slack
 *     channel, an emailed digest)
 *   - commit it to a public repo (the push is recorded by someone else)
 *   - send it to a transparency log or a notary
 *   - literally read it aloud on a recorded call, once a quarter
 *
 * Any of those beats the best cryptography stored on the attacker's disk. The
 * value is in the copy YOU do not control.
 *
 * WHAT THE SIGNATURE IS FOR: it stops a third party fabricating a checkpoint to
 * frame an honest operator. It does NOT defend against a compromised gate — that
 * gate holds the key and signs whatever it likes. Only your earlier copy does.
 *
 * Run it on a schedule. Hourly is plenty; the finest granularity you can prove is
 * the interval between checkpoints.
 */
import { writeFileSync } from "node:fs";
import { openLedgerStrict, closeLedger, publishHead, chainHead } from "@ramp/ledger";
import { demoGatePrivateKey, DEMO_GATE_KEY_ID } from "@ramp/provenance";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
const quiet = argv.includes("--quiet");

const db = openLedgerStrict();
try {
  const { length } = chainHead(db);
  const checkpoint = publishHead(db, demoGatePrivateKey(), DEMO_GATE_KEY_ID);
  const json = JSON.stringify(checkpoint, null, 2);

  if (out) {
    writeFileSync(out, json + "\n", "utf8");
    if (!quiet) {
      process.stderr.write(
        `\nwrote a checkpoint for ${length} decision(s) to ${out}\n` +
          `head ${checkpoint.statement.head.slice(0, 24)}…\n\n` +
          `THIS FILE IS NOT A WITNESS while it sits on the same disk as the ledger.\n` +
          `Publish it somewhere the operator cannot rewrite — a status page, a\n` +
          `customer's inbox, a public commit, a transparency log. The value is in\n` +
          `the copy you do not control.\n\n` +
          `Check it later:  pnpm proof --checkpoint ${out}\n\n`,
      );
    }
  } else {
    process.stdout.write(json + "\n");
  }
} finally {
  closeLedger(db);
}

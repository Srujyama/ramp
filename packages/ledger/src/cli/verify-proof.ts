/**
 * @ramp/ledger — cli/verify-proof.ts
 *
 * `pnpm verify-proof <decisionId>` — independently re-verify the tamper-evident
 * proof stored for one decision. This CLI is READ-ONLY: it opens the ledger with
 * `provisionIfEmpty: false` and NEVER writes (no recordDecision, no mutation). The
 * proof id is recomputed from the stored content, so a tampered record is caught
 * even though the ledger dutifully persisted it.
 *
 * Exit codes are meaningful (see the EXIT_* constants) so this composes in scripts
 * and CI. The pure {@link runVerifyProof} core returns the code + output lines so
 * every code path is unit-testable WITHOUT spawning a process or calling
 * `process.exit`; only the thin {@link main} wrapper touches the process.
 */
import { pathToFileURL } from "node:url";
import {
  openLedger,
  closeLedger,
  DEFAULT_DB_PATH,
  type LedgerDb,
} from "../db.js";
import { getDecision, type DecisionRecord } from "../decision-log.js";
import { verifyDecisionProof } from "../proof-verification.js";

/** Proof present and independently re-verified. */
export const EXIT_OK = 0;
/** Unexpected/internal error (e.g. the ledger could not be opened). */
export const EXIT_ERROR = 1;
/** Missing/invalid CLI argument. */
export const EXIT_USAGE = 2;
/** No decision with the given id exists in the ledger. */
export const EXIT_NOT_FOUND = 3;
/** The decision exists but carries NO proof to verify. */
export const EXIT_MISSING_PROOF = 4;
/** A proof is present but its content is corrupt/malformed (recompute threw). */
export const EXIT_CORRUPT = 5;
/** A proof is present but recomputes to a DIFFERENT id (tampered/invalid). */
export const EXIT_MISMATCH = 6;

/** One-line usage string (also surfaced by tooling/docs). */
export const USAGE =
  "usage: verify-proof <decisionId>  " +
  "(reads $RAMP_DB_PATH or ./" +
  DEFAULT_DB_PATH +
  "; read-only)";

/** Result of the pure verify-proof core: an exit code plus stdout/stderr lines. */
export interface VerifyProofRun {
  readonly code: number;
  /** Lines destined for stdout (the human-readable result). */
  readonly out: readonly string[];
  /** Lines destined for stderr (errors: not-found, usage, etc.). */
  readonly err: readonly string[];
}

/**
 * Pure mapping from a fetched decision record (or `undefined`) to a
 * {@link VerifyProofRun}. Separated from DB access so the exit-code mapping —
 * including the corrupt-proof path that a JSON round-trip cannot reach — is fully
 * unit-testable. Never throws; never touches the process.
 */
export function verifyProofResultFor(
  record: DecisionRecord | undefined,
  decisionId: string,
): VerifyProofRun {
  if (record === undefined) {
    return { code: EXIT_NOT_FOUND, out: [], err: [`decision not found: ${decisionId}`] };
  }

  const v = verifyDecisionProof(record);

  const out: string[] = [
    `decision:      ${record.decisionId}`,
    `status:        ${record.status}${record.outcome !== null ? ` (${record.outcome})` : ""}`,
    `record corrupt:${record.corrupt}`,
    `proof present: ${v.proofPresent}`,
    `proofVerified: ${v.proofVerified}`,
    `reason:        ${v.reason}`,
  ];
  if (v.actualProofId !== null) out.push(`stored id:     ${v.actualProofId}`);
  if (v.expectedProofId !== null) out.push(`recomputed id: ${v.expectedProofId}`);

  let code: number;
  switch (v.reason) {
    case "ok":
      code = EXIT_OK;
      break;
    case "absent":
      code = EXIT_MISSING_PROOF;
      break;
    case "corrupt":
      code = EXIT_CORRUPT;
      break;
    case "mismatch":
      code = EXIT_MISMATCH;
      break;
  }
  return { code, out, err: [] };
}

/**
 * Pure verify-proof core: fetch the decision READ-ONLY and independently
 * re-verify its proof. Returns the exit code and output lines; does not write to
 * the ledger, does not print, does not exit.
 */
export function runVerifyProof(args: {
  db: LedgerDb;
  decisionId: string;
}): VerifyProofRun {
  return verifyProofResultFor(getDecision(args.db, args.decisionId), args.decisionId);
}

/**
 * Thin process wrapper: parse argv, open the ledger read-only, print the result,
 * and exit with the mapped code. The ONLY place `process.exit` is used. The DB is
 * always closed (finally) before the process exits.
 */
export function main(argv: readonly string[] = process.argv): void {
  const decisionId = argv[2];
  if (decisionId === undefined || decisionId === "") {
    process.stderr.write(USAGE + "\n");
    process.exit(EXIT_USAGE);
    return;
  }

  const dbPath = process.env.RAMP_DB_PATH ?? DEFAULT_DB_PATH;
  let code = EXIT_ERROR;
  let db: LedgerDb | undefined;
  try {
    db = openLedger(dbPath, { provisionIfEmpty: false });
    const result = runVerifyProof({ db, decisionId });
    for (const line of result.out) process.stdout.write(line + "\n");
    for (const line of result.err) process.stderr.write(line + "\n");
    code = result.code;
  } catch (err) {
    // No stack trace — a short, honest message only.
    process.stderr.write(`verify-proof: ${(err as Error).message}\n`);
    code = EXIT_ERROR;
  } finally {
    if (db !== undefined) closeLedger(db);
  }
  process.exit(code);
}

// Run only when invoked directly (never on import, so tests can import freely).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

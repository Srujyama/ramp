/**
 * @ramp/ledger — chain.ts (tamper-evidence ACROSS decisions)
 *
 * ============================================================================
 * THE GAP THIS CLOSES (verified empirically before it was written)
 * ============================================================================
 * A `LedgerProof` commits to its own content: recompute `proofId` from the proof
 * and a mismatch means somebody edited it. That catches tampering WITHIN one
 * decision, and it is genuinely useful.
 *
 * It catches nothing about the SET of decisions. Every proof is an island: no
 * proof references any other, so the audit trail has no opinion about which
 * decisions exist or what order they happened in. Concretely, before this file:
 *
 *   DELETE FROM decisions WHERE decision_id = '<the one that embarrasses me>';
 *
 * ...and every remaining proof still verifies perfectly. The trail is now a lie
 * — the expensive kind, because every check on it passes. That was demonstrated
 * against the real seeded DB, not assumed: delete a deny row, and both
 * `verifyProof` and the dashboard report a clean, fully-verified history.
 *
 * The threat is not hypothetical for an audit trail. The whole reason to keep
 * one is the decision someone later wishes had not happened. "Nobody edited a
 * record" is worth little if anyone can drop the record entirely.
 *
 * ============================================================================
 * THE FIX: each decision commits to the one before it
 * ============================================================================
 * Every decision carries `prevChainHash` — the chain hash of the decision
 * recorded before it — and its own `chainHash = H(prevChainHash || proofId)`.
 * That makes the log a hash chain: each entry's identity depends on the entire
 * history behind it.
 *
 * Now removing entry N breaks entry N+1's `prevChainHash`, which breaks N+2's,
 * and so on to the head. Reordering breaks it. Inserting a fabricated decision
 * mid-history breaks it. The only tamper that survives is rewriting the ENTIRE
 * suffix from the edit point to the head — and if you also publish the head
 * somewhere the attacker doesn't control (see `chainHead`), even that is caught.
 *
 * WHAT THIS DOES NOT DO, stated plainly:
 *   - It does not stop deletion. It makes deletion DETECTABLE. Nothing in a
 *     database can stop someone with write access from deleting rows; the
 *     achievable goal is that they cannot do it QUIETLY.
 *   - It does not protect the head. An attacker who rewrites the whole suffix
 *     produces a self-consistent chain with a different head. Detecting that
 *     requires comparing the head against a copy they don't control — which is
 *     exactly what `chainHead()` is for, and why it is worth publishing.
 *   - It says nothing about whether any decision was CORRECT. That is soundness,
 *     and it is @ramp/provenance's job. Integrity, chain integrity, and
 *     soundness are three different guarantees; this file provides the middle
 *     one only.
 */
import { sha256OfJson } from "./canonical-hash.js";
import type { LedgerDb } from "./db.js";

/** The genesis link. An empty chain hashes from here, not from nothing. */
export const GENESIS_CHAIN_HASH = "chain_genesis";

/**
 * The chain hash for one entry: `H(prev || proofId)`.
 *
 * Deliberately depends on BOTH the previous hash (position in history) and this
 * decision's proof id (its content). A chain over positions alone would let you
 * swap a decision's contents while keeping the chain intact; a chain over
 * contents alone would let you reorder. It has to be both.
 *
 * `decisionId` is folded in too, so an 'error' row with no proof still occupies
 * an unforgeable position rather than being a hole an attacker can fill.
 */
export function linkHash(
  prevChainHash: string,
  proofId: string | null,
  decisionId: string,
): string {
  return sha256OfJson({
    prev: prevChainHash,
    proofId: proofId ?? null,
    decisionId,
  });
}

/** One row's chain position, as stored. */
export interface ChainLink {
  readonly decisionId: string;
  readonly prevChainHash: string;
  readonly chainHash: string;
  readonly proofId: string | null;
  /** Monotonic position. 1-based; genesis is position 0. */
  readonly seq: number;
}

/**
 * The current head of the chain — the hash of the most recent decision.
 *
 * PUBLISH THIS. It is a single short string that commits to the entire history:
 * every decision, in order, unaltered. Post it hourly to somewhere the ledger's
 * operator cannot rewrite (a status page, a transparency log, a customer's
 * inbox, a tweet) and you close the last hole: an attacker who rewrites the
 * whole suffix still cannot make the head match what you published yesterday.
 *
 * That is the entire trick behind certificate transparency, and it costs one
 * string.
 */
export function chainHead(db: LedgerDb): { head: string; length: number } {
  const row = db
    .prepare(
      `SELECT chain_hash AS head, seq FROM decisions
        WHERE chain_hash IS NOT NULL
        ORDER BY seq DESC LIMIT 1`,
    )
    .get() as { head: string; seq: number } | undefined;
  return row ? { head: row.head, length: row.seq } : { head: GENESIS_CHAIN_HASH, length: 0 };
}

/**
 * Compute the link for the NEXT decision, given the current head. Called inside
 * `recordDecision`'s transaction so the chain cannot fork under concurrency:
 * two writers racing would otherwise both read the same head and both claim the
 * same position.
 */
export function nextLink(
  db: LedgerDb,
  decisionId: string,
  proofId: string | null,
): { prevChainHash: string; chainHash: string; seq: number } {
  const { head, length } = chainHead(db);
  return {
    prevChainHash: head,
    chainHash: linkHash(head, proofId, decisionId),
    seq: length + 1,
  };
}

/** Why a chain verification failed. Stable; rendered in audit output. */
export type ChainDefectKind =
  /** A row's chain_hash is not H(prev || proofId) — its content or link was edited. */
  | "broken_link"
  /** A row's prev doesn't match the previous row's chain_hash — something was removed or reordered. */
  | "broken_prev"
  /** Sequence numbers are not contiguous — a row was deleted outright. */
  | "gap"
  /** The first row doesn't chain from genesis — history was truncated at the front. */
  | "bad_genesis"
  /** Two rows claim the same position. */
  | "duplicate_seq";

export interface ChainDefect {
  readonly kind: ChainDefectKind;
  readonly seq: number;
  readonly decisionId: string;
  readonly detail: string;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly length: number;
  readonly head: string;
  readonly defects: readonly ChainDefect[];
}

/**
 * Walk the whole chain and verify it.
 *
 * Reports EVERY defect rather than stopping at the first: an auditor wants to
 * know the shape of the damage, and "the chain broke at position 3" is a much
 * worse report than "positions 3, 4, and 5 are gone."
 *
 * Total: never throws. A malformed row is a defect, not an exception.
 *
 * @param expectedHead when supplied, the head is compared against a value you
 *   published earlier. THIS is the check that catches a full-suffix rewrite —
 *   without it, a self-consistent forged chain passes everything above.
 */
export function verifyChain(db: LedgerDb, expectedHead?: string): ChainVerification {
  const rows = db
    .prepare(
      `SELECT decision_id AS decisionId, prev_chain_hash AS prevChainHash,
              chain_hash AS chainHash, seq,
              (SELECT proof_id FROM decision_proofs p WHERE p.decision_id = d.decision_id) AS proofId
         FROM decisions d
        WHERE seq IS NOT NULL
        ORDER BY seq ASC`,
    )
    .all() as unknown as Array<ChainLink>;

  const defects: ChainDefect[] = [];
  let prev = GENESIS_CHAIN_HASH;
  const seen = new Set<number>();

  rows.forEach((row, i) => {
    const expectedSeq = i + 1;

    if (seen.has(row.seq)) {
      defects.push({
        kind: "duplicate_seq",
        seq: row.seq,
        decisionId: row.decisionId,
        detail: `two decisions claim position ${row.seq}`,
      });
    }
    seen.add(row.seq);

    // A gap is the smoking gun for a deleted row: the surviving rows still
    // verify individually, and their positions no longer count from 1 upward.
    if (row.seq !== expectedSeq) {
      defects.push({
        kind: "gap",
        seq: row.seq,
        decisionId: row.decisionId,
        detail: `expected position ${expectedSeq}, found ${row.seq} — ${row.seq - expectedSeq} decision(s) removed before this one`,
      });
    }

    if (i === 0 && row.prevChainHash !== GENESIS_CHAIN_HASH) {
      defects.push({
        kind: "bad_genesis",
        seq: row.seq,
        decisionId: row.decisionId,
        detail: "the first decision does not chain from genesis — history was truncated at the front",
      });
    }

    if (row.prevChainHash !== prev) {
      defects.push({
        kind: "broken_prev",
        seq: row.seq,
        decisionId: row.decisionId,
        detail: `prev ${short(row.prevChainHash)} != previous row's chain hash ${short(prev)} — a decision was removed, reordered, or inserted here`,
      });
    }

    const recomputed = linkHash(row.prevChainHash, row.proofId, row.decisionId);
    if (recomputed !== row.chainHash) {
      defects.push({
        kind: "broken_link",
        seq: row.seq,
        decisionId: row.decisionId,
        detail: `chain hash ${short(row.chainHash)} != recomputed ${short(recomputed)} — this row's proof or link was altered`,
      });
    }

    prev = row.chainHash;
  });

  const head = rows.length > 0 ? rows[rows.length - 1]!.chainHash : GENESIS_CHAIN_HASH;

  if (expectedHead !== undefined && head !== expectedHead) {
    defects.push({
      kind: "broken_link",
      seq: rows.length,
      decisionId: "(head)",
      detail:
        `chain head ${short(head)} != the published head ${short(expectedHead)}. ` +
        `The chain is internally consistent but is NOT the history you published — ` +
        `the whole suffix was rewritten.`,
    });
  }

  return { valid: defects.length === 0, length: rows.length, head, defects };
}

function short(h: string): string {
  return h.length > 18 ? h.slice(0, 18) + "…" : h;
}

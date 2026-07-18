/**
 * @ramp/ledger — head-checkpoint.ts (the external witness)
 *
 * ============================================================================
 * THE HOLE THE CHAIN LEAVES, AND WHY A BARE HEAD DOESN'T CLOSE IT
 * ============================================================================
 * The hash chain makes deletion and reordering detectable — remove entry N and
 * N+1's `prev` no longer matches. But it cannot catch a determined operator who
 * rewrites the ENTIRE SUFFIX: recompute every link from the edit point to the
 * head and the result is a perfectly self-consistent chain. Internally flawless,
 * and a different history.
 *
 * `verifyChain(db, expectedHead)` was the first answer: compare today's head to
 * one you published yesterday. It is nearly useless in practice, and the reason
 * is embarrassing — THE HEAD CHANGES EVERY TIME ANYONE SPENDS. An honest append
 * moves the head, so `expectedHead !== currentHead` fires on normal operation.
 * A check that cries wolf on every legitimate payment is a check nobody runs.
 *
 * ============================================================================
 * WHAT ACTUALLY WORKS: A CONSISTENCY CHECK
 * ============================================================================
 * The question is not "is the head the same?" — it should not be. The question
 * is: **"is the history I saw before still a PREFIX of the history I see now?"**
 *
 * That is answerable. A checkpoint records `(head, length)` at a moment in time. To
 * check it later, look at position `length` in today's chain: if its
 * `chain_hash` is still `head`, everything you witnessed is intact and the chain
 * merely grew. If it differs, the history you saw has been rewritten — no matter
 * how self-consistent today's chain looks.
 *
 * That is certificate transparency's consistency proof, in about forty lines,
 * and it works precisely BECAUSE the chain grows: each link commits to every link
 * before it, so one hash at one position vouches for the whole prefix.
 *
 * ============================================================================
 * THE PART THAT IS NOT CODE
 * ============================================================================
 * None of this works unless the checkpoint lives somewhere THE OPERATOR CANNOT
 * REWRITE. A checkpoint in the same database is worthless — an attacker who rewrites
 * the chain rewrites the checkpoint in the same transaction. So this module PRODUCES
 * checkpoints and VERIFIES against them; it deliberately does not store them.
 * Publishing is a deployment decision (a transparency log, a status page, a
 * customer's inbox, a chat channel, a git commit — anything with a witness).
 *
 * The signature is NOT what makes this work, and it is worth being blunt: a
 * compromised gate has the key and signs whatever it likes. What makes it work is
 * that the AUDITOR HELD A COPY FROM BEFORE. The signature only stops a third
 * party fabricating a checkpoint to frame an honest operator — useful, but secondary.
 * If you take one thing from this file: the value is in the copy you don't
 * control, not in the cryptography.
 */
import { canonicalJson } from "@ramp/shared";
import { signBundleDigest, verifyBundleSignature } from "@ramp/provenance";
import type { GateSignature } from "@ramp/provenance";
import type { KeyObject } from "node:crypto";
import { sha256OfJson } from "./canonical-hash.js";
import { chainHead, GENESIS_CHAIN_HASH } from "./chain.js";
import type { LedgerDb } from "./db.js";

/** The claim inside a checkpoint: what the chain looked like at a moment. */
export interface HeadStatement {
  readonly schema: "ramp/head-checkpoint-v1";
  /** The chain hash of the most recent decision at that moment. */
  readonly head: string;
  /** How many decisions the chain held. The POSITION `head` sits at. */
  readonly length: number;
  /** RFC 3339 instant the checkpoint was produced. */
  readonly at: string;
}

/** A published head checkpoint: the statement plus the gate's signature over it. */
export interface HeadCheckpoint {
  readonly statement: HeadStatement;
  readonly signature: GateSignature;
}

/** The bytes signed: a digest of the canonical statement, domain-separated. */
function statementDigest(s: HeadStatement): string {
  return sha256OfJson(JSON.parse(canonicalJson(s)) as never);
}

/**
 * Produce a signed checkpoint for the chain's current head.
 *
 * PUBLISH THE RESULT somewhere you do not control. A checkpoint that lives only in
 * the ledger it describes proves nothing: whoever rewrites the chain rewrites the
 * checkpoint beside it, in the same transaction.
 */
export function publishHead(
  db: LedgerDb,
  gateKey: KeyObject,
  gateKeyId: string,
  at: string = new Date().toISOString(),
): HeadCheckpoint {
  const { head, length } = chainHead(db);
  const statement: HeadStatement = { schema: "ramp/head-checkpoint-v1", head, length, at };
  return { statement, signature: signBundleDigest(statementDigest(statement), gateKey, gateKeyId) };
}

/** Why a consistency check failed. */
export type ConsistencyFailure =
  | "malformed"
  | "bad_signature"
  | "history_rewritten"
  | "history_truncated";

export interface ConsistencyResult {
  readonly consistent: boolean;
  readonly code: ConsistencyFailure | "ok";
  readonly detail: string;
  /** How many decisions have been appended since the checkpoint. */
  readonly grownBy: number;
}

/** Total structural check. Any shape yields a boolean, never a throw. */
function looksLikeCheckpoint(v: unknown): v is HeadCheckpoint {
  if (typeof v !== "object" || v === null) return false;
  const r = v as HeadCheckpoint;
  return (
    typeof r.statement === "object" &&
    r.statement !== null &&
    typeof r.statement.head === "string" &&
    typeof r.statement.length === "number" &&
    typeof r.statement.at === "string" &&
    typeof r.signature === "object"
  );
}

/**
 * THE CHECK. Is the history in `checkpoint` still a PREFIX of the chain today?
 *
 * Not "is the head unchanged" — it should have changed; the chain grows. This
 * asks whether everything the checkpoint witnessed is still there, unaltered, in the
 * same order, with new decisions appended after it.
 *
 * WHAT PASSING MEANS, PRECISELY. The prefix has not been REPLACED: nothing was
 * truncated below the witnessed length, and position `length` still hashes to
 * what you saw — which a full-suffix rewrite necessarily changes.
 *
 * WHAT IT DOES NOT MEAN. This checks ONE position, so it is blind to a sloppy
 * in-prefix edit: `UPDATE ... SET chain_hash = 'x' WHERE seq = 2` does not
 * recompute the stored hashes downstream, so position `length` is untouched and
 * this check passes. `verifyChain` is what catches that, by recomputing every
 * link.
 *
 * So the two are COMPLEMENTARY and neither is sufficient alone:
 *   - verifyChain  catches edits, deletions, reordering — blind to a
 *                  self-consistent full-suffix rewrite.
 *   - this         catches exactly that rewrite — blind to an in-prefix edit.
 *
 * RUN BOTH. `pnpm proof` does, and says so.
 *
 * @param keyring trusted gate keys. Supplied OUT OF BAND — a key read from the
 *   checkpoint would prove nothing, since a forger includes their own.
 *
 * Total: malformed input is a verdict, never a throw.
 */
export function verifyAgainstCheckpoint(
  db: LedgerDb,
  checkpoint: unknown,
  keyring: ReadonlyMap<string, KeyObject>,
): ConsistencyResult {
  if (!looksLikeCheckpoint(checkpoint)) {
    return { consistent: false, code: "malformed", detail: "not a HeadCheckpoint", grownBy: 0 };
  }
  const { statement } = checkpoint;

  // Authenticity first: never reason about the contents of a statement we have
  // not established is genuine. This stops a third party fabricating a checkpoint
  // to frame an honest operator.
  const sig = verifyBundleSignature(statementDigest(statement), checkpoint.signature, keyring);
  if (!sig.verified) {
    return {
      consistent: false,
      code: "bad_signature",
      detail: `checkpoint signature: ${sig.detail}`,
      grownBy: 0,
    };
  }

  const now = chainHead(db);

  // Genesis checkpoints are trivially consistent with anything.
  if (statement.length === 0) {
    return {
      consistent: statement.head === GENESIS_CHAIN_HASH,
      code: statement.head === GENESIS_CHAIN_HASH ? "ok" : "history_rewritten",
      detail: "checkpoint was taken at genesis",
      grownBy: now.length,
    };
  }

  if (now.length < statement.length) {
    // The chain is SHORTER than what we witnessed. Decisions we saw are simply
    // gone — no hash comparison needed.
    return {
      consistent: false,
      code: "history_truncated",
      detail:
        `the chain now holds ${now.length} decisions but the checkpoint witnessed ` +
        `${statement.length}. ${statement.length - now.length} decision(s) that ` +
        `demonstrably existed are gone.`,
      grownBy: 0,
    };
  }

  // THE PREFIX CHECK. One hash at one position vouches for the entire prefix,
  // because every link commits to every link before it.
  const at = db
    .prepare("SELECT chain_hash AS h FROM decisions WHERE seq = ?")
    .get(statement.length) as { h: string } | undefined;

  if (!at) {
    return {
      consistent: false,
      code: "history_truncated",
      detail: `no decision at position ${statement.length}; the witnessed history is gone.`,
      grownBy: now.length - statement.length,
    };
  }

  if (at.h !== statement.head) {
    return {
      consistent: false,
      code: "history_rewritten",
      detail:
        `position ${statement.length} now hashes to ${at.h.slice(0, 18)}… but the checkpoint ` +
        `witnessed ${statement.head.slice(0, 18)}…. The history you saw has been REWRITTEN. ` +
        `Today's chain may be internally perfect and it is not the one you were shown.`,
      grownBy: now.length - statement.length,
    };
  }

  return {
    consistent: true,
    code: "ok",
    detail:
      `everything the checkpoint witnessed (${statement.length} decision(s)) is intact; ` +
      `${now.length - statement.length} appended since.`,
    grownBy: now.length - statement.length,
  };
}

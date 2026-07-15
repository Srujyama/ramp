/**
 * @ramp/provenance — the decision bundle (PILLAR 2)
 *
 * ============================================================================
 * "PROVES THE DECISION AT ENFORCE TIME, NOT JUST LOGS IT AFTER."
 * ============================================================================
 * An audit log says: *the agent paid Acme $340 at 14:02.* It is a claim, written
 * by the system, about the system. To believe it you must already trust the
 * thing you are auditing. That is fine for SOX — it answers "what happened?" —
 * and useless for "was this decision correct?", because a compromised or buggy
 * gate writes a beautiful log.
 *
 * A bundle is different in kind. It records the DECISION, the exact FACTS it was
 * computed from, and, for each fact, WHERE THAT FACT CAME FROM — the table, the
 * column, the query, the key; or the notary and statement digest; or the
 * declassifier and its codomain. Then {@link verifyBundle} lets anyone re-run
 * the kernel on those recorded facts and check that the recorded decision is
 * what falls out.
 *
 * The auditor does not have to trust our gate. They re-derive the answer.
 *
 * That works only because the kernel is pure and deterministic — same Facts,
 * same Decision, no clock, no I/O, no randomness. Determinism is not an
 * aesthetic preference here; it is what makes a decision REPRODUCIBLE, and
 * reproducibility is what makes it PROVABLE. This package is the cash-out of
 * that design choice.
 *
 * What a bundle proves, precisely:
 *   1. The facts have not been edited since the decision (content-addressed).
 *   2. The decision FOLLOWS FROM those facts (re-derived, not believed).
 *   3. Every fact is accounted for by an authoritative source (completeness).
 *   4. The provenance agrees with the facts it claims to explain.
 *
 * What a bundle does NOT prove: that the ledger itself told the truth. Nothing
 * downstream can prove that; it is why `vendor_verified` is backed by pillar 4's
 * cryptography rather than by a database boolean alone. Provenance makes the
 * chain VISIBLE and CHECKABLE end to end — it does not make its roots honest.
 * Stating that limit is part of the proof.
 */
import {
  canonicalJson,
  FACT_SOURCES,
  type Decision,
  type Facts,
  type FactSource,
  type PolicyKernel,
} from "@ramp/shared";

/** Bundle format version. Part of the digest. */
export const BUNDLE_VERSION = 1 as const;

/** Every field name in `Facts` — the completeness checklist. */
const FACT_KEYS = Object.keys(FACT_SOURCES) as ReadonlyArray<keyof Facts>;

/**
 * HOW a fact was derived — the specific, checkable step, not just a category.
 *
 * "It came from the ledger" is a category and is not auditable. "It is the value
 * of `vendors.verified` where `vendor_id = 'acme_corp'`, via this exact SQL" is
 * a claim an auditor can go and independently check against the database. The
 * difference between those two sentences is the difference between a log and a
 * proof, so this type deliberately makes the vague version unrepresentable.
 */
export type Derivation =
  /** Copied verbatim from a structured tool argument (an identity/intent KEY only). */
  | { readonly kind: "structured_arg"; readonly field: string }
  /** Read from the authoritative DB. Records the query and the bound parameters. */
  | {
      readonly kind: "sql";
      readonly table: string;
      readonly query: string;
      readonly params: readonly string[];
    }
  /** Established by @ramp/attestation's verified verdict. */
  | {
      readonly kind: "attestation";
      readonly notaryKeyId: string;
      readonly statementDigest: string;
      readonly verified: boolean;
    }
  /** Produced by declassifying quarantined content through a bounded codomain. */
  | {
      readonly kind: "declassified";
      readonly contentId: string;
      readonly declassifier: string;
      readonly codomain: string;
      readonly admitted: boolean;
    }
  /** A constant of the policy itself, not read from anywhere. */
  | { readonly kind: "constant"; readonly note: string };

/** The provenance of ONE fact: its value, its source category, and its derivation. */
export interface FactProvenance {
  /** Which `Facts` field this explains. */
  readonly fact: keyof Facts;
  /** The value as it appears in `Facts`. Cross-checked by verifyBundle. */
  readonly value: string | number | boolean | readonly string[];
  /** The broad category, from @ramp/shared's FACT_SOURCES. */
  readonly source: FactSource;
  /** The specific, independently checkable derivation. */
  readonly derivation: Derivation;
}

/** Which kernel produced the decision. Recorded so parity failures are traceable. */
export interface KernelIdentity {
  /** "reference" | "wasm" — see @ramp/shared's KernelKind. */
  readonly kind: string;
  /** Digest of the policy program, when the kernel can supply one. */
  readonly policyDigest?: string;
}

/**
 * A complete, self-contained, independently verifiable record of one decision.
 *
 * Self-contained is the point: everything needed to re-derive the verdict is in
 * here. An auditor needs this object and a kernel — not our database, not our
 * process, not our word.
 */
export interface DecisionBundle {
  readonly bundleVersion: typeof BUNDLE_VERSION;
  /** The request this decided. */
  readonly requestId: string;
  /** The exact facts the kernel evaluated. */
  readonly facts: Facts;
  /** sha256 of `canonicalJson(facts)` — pins the facts against later edits. */
  readonly factsDigest: string;
  /** One entry per `Facts` field. Completeness is enforced, not hoped for. */
  readonly provenance: readonly FactProvenance[];
  /** What the kernel decided. */
  readonly decision: Decision;
  /** Which kernel decided it. */
  readonly kernel: KernelIdentity;
  /**
   * When the decision was made (RFC 3339). Recorded for the audit trail and
   * EXCLUDED from `factsDigest` — the facts are what the kernel saw, and the
   * kernel never sees a clock. Included in `bundleDigest`, which pins the whole
   * record including its metadata.
   */
  readonly evaluatedAt: string;
  /** sha256 over everything above. Pins the entire bundle. */
  readonly bundleDigest: string;
}

/**
 * A sha256-hex-of-a-string function.
 *
 * INJECTED rather than imported so this module stays free of `node:crypto` and
 * can therefore run in a browser. That is not a portability nicety — it is what
 * lets the DASHBOARD re-verify a bundle in front of you with WebCrypto, using
 * THIS EXACT verification logic rather than a second, weaker reimplementation
 * that might disagree. One verifier, two hosts.
 */
export type Sha256Hex = (input: string) => string;

/** Everything in a bundle except `bundleDigest`, which is computed over it. */
export type UnsealedBundle = Omit<DecisionBundle, "bundleDigest">;

/** Inputs to {@link buildBundle}. */
export interface BuildBundleInput {
  readonly requestId: string;
  readonly facts: Facts;
  readonly provenance: readonly FactProvenance[];
  readonly decision: Decision;
  readonly kernel: KernelIdentity;
  /**
   * RFC 3339 timestamp, INJECTED rather than read here.
   *
   * Same reasoning as @ramp/attestation's `now`: keeping the clock out of this
   * function makes bundle construction pure and byte-reproducible in tests. A
   * builder that reads the clock produces a different bundle every run, which
   * makes content-addressing untestable.
   */
  readonly evaluatedAt: string;
}

/**
 * Assemble and seal a decision bundle, using the supplied digest function.
 *
 * Note what this does NOT do: it does not check that the provenance is honest or
 * complete. That is {@link verifyBundleCore}'s job, and keeping the two apart is
 * deliberate — a builder that validated its own output would be marking its own
 * homework, and the verifier has to be runnable by someone who does not trust
 * the builder at all.
 */
export function buildBundleWith(
  input: BuildBundleInput,
  sha256: Sha256Hex,
): DecisionBundle {
  const unsealed: UnsealedBundle = {
    bundleVersion: BUNDLE_VERSION,
    requestId: input.requestId,
    facts: input.facts,
    factsDigest: sha256(canonicalJson(input.facts)),
    provenance: input.provenance,
    decision: input.decision,
    kernel: input.kernel,
    evaluatedAt: input.evaluatedAt,
  };
  return { ...unsealed, bundleDigest: sha256(canonicalJson(unsealed)) };
}

/** Machine-readable reasons a bundle fails verification. */
export type BundleFailure =
  | "malformed"
  | "version_mismatch"
  | "facts_digest_mismatch"
  | "bundle_digest_mismatch"
  | "decision_mismatch"
  | "provenance_incomplete"
  | "provenance_value_mismatch"
  | "provenance_duplicate";

/** One thing wrong with a bundle. */
export interface BundleDefect {
  readonly code: BundleFailure;
  readonly detail: string;
}

/** The verdict. `valid` only when EVERY check passed. */
export interface BundleVerification {
  readonly valid: boolean;
  /** Empty iff valid. Every defect found, not just the first. */
  readonly defects: readonly BundleDefect[];
  /** The decision re-derived from the recorded facts, when it could be computed. */
  readonly rederivedDecision: Decision | null;
}

/** Total structural check. Any input shape yields a boolean, never a throw. */
function looksLikeBundle(value: unknown): value is DecisionBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.requestId === "string" &&
    typeof b.factsDigest === "string" &&
    typeof b.bundleDigest === "string" &&
    typeof b.evaluatedAt === "string" &&
    typeof b.bundleVersion === "number" &&
    typeof b.facts === "object" &&
    b.facts !== null &&
    Array.isArray(b.provenance) &&
    typeof b.decision === "object" &&
    b.decision !== null &&
    typeof b.kernel === "object" &&
    b.kernel !== null
  );
}

/**
 * THE AUDITOR'S FUNCTION. Independently verify a decision bundle.
 *
 * Give it a bundle and a kernel; it re-derives the decision from the recorded
 * facts and checks the whole chain. It never touches our database, our process,
 * or our claims — which is exactly why its verdict is worth something.
 *
 * Reports EVERY defect rather than stopping at the first: an auditor wants the
 * full picture, and "there is at least one problem" is a worse report than
 * "here are all four."
 *
 * Total: malformed input is a verdict, never a throw.
 */
export function verifyBundleCore(
  bundle: unknown,
  kernel: PolicyKernel,
  sha256: Sha256Hex,
): BundleVerification {
  const defects: BundleDefect[] = [];

  if (!looksLikeBundle(bundle)) {
    return {
      valid: false,
      defects: [{ code: "malformed", detail: "not a well-formed DecisionBundle" }],
      rederivedDecision: null,
    };
  }

  if (bundle.bundleVersion !== BUNDLE_VERSION) {
    return {
      valid: false,
      defects: [
        {
          code: "version_mismatch",
          detail: `bundle version ${bundle.bundleVersion} != supported ${BUNDLE_VERSION}`,
        },
      ],
      rederivedDecision: null,
    };
  }

  // ---- 1. Integrity: were the facts edited after the decision? -----------
  const recomputedFacts = sha256(canonicalJson(bundle.facts));
  if (recomputedFacts !== bundle.factsDigest) {
    defects.push({
      code: "facts_digest_mismatch",
      detail: `factsDigest ${bundle.factsDigest} != recomputed ${recomputedFacts} — the facts were altered after sealing`,
    });
  }

  const { bundleDigest, ...unsealed } = bundle;
  const recomputedBundle = sha256(canonicalJson(unsealed as UnsealedBundle));
  if (recomputedBundle !== bundleDigest) {
    defects.push({
      code: "bundle_digest_mismatch",
      detail: `bundleDigest ${bundleDigest} != recomputed ${recomputedBundle} — the bundle was altered after sealing`,
    });
  }

  // ---- 2. Soundness: does the decision FOLLOW from the facts? ------------
  // The heart of it. We do not read the recorded decision and believe it; we
  // recompute it and compare. A tampered decision, a buggy kernel, or a kernel
  // that has drifted since the decision all surface here.
  let rederived: Decision | null = null;
  try {
    rederived = kernel.evaluate(bundle.facts);
  } catch (err) {
    defects.push({
      code: "decision_mismatch",
      detail: `the kernel threw while re-deriving: ${(err as Error).message}`,
    });
  }

  if (rederived) {
    const recorded = bundle.decision;
    if (canonicalJson(rederived) !== canonicalJson(recorded)) {
      defects.push({
        code: "decision_mismatch",
        detail:
          `the recorded decision does not follow from the recorded facts. ` +
          `recorded=${canonicalJson(recorded)} rederived=${canonicalJson(rederived)}`,
      });
    }
  }

  // ---- 3. Completeness: is every fact accounted for? ---------------------
  // An unexplained fact is an unaudited fact. If a value can enter the decision
  // without anyone naming its source, the graph has a hole exactly the shape of
  // an injected fact — so this is enforced mechanically against Facts' own
  // field list, not left to reviewer diligence.
  const explained = new Map<string, FactProvenance>();
  for (const p of bundle.provenance) {
    if (explained.has(p.fact)) {
      defects.push({
        code: "provenance_duplicate",
        detail: `fact "${p.fact}" has more than one provenance entry — which one is true?`,
      });
      continue;
    }
    explained.set(p.fact, p);
  }

  for (const key of FACT_KEYS) {
    if (!explained.has(key)) {
      defects.push({
        code: "provenance_incomplete",
        detail: `fact "${key}" has no provenance entry — its origin is unaccounted for`,
      });
    }
  }

  for (const p of bundle.provenance) {
    if (!(FACT_KEYS as readonly string[]).includes(p.fact)) {
      defects.push({
        code: "provenance_incomplete",
        detail: `provenance names "${p.fact}", which is not a field of Facts`,
      });
    }
  }

  // ---- 4. Honesty: does the provenance agree with the facts? -------------
  // Provenance that disagrees with the fact it claims to explain is worse than
  // no provenance: it is a plausible, checkable-looking lie.
  for (const [key, p] of explained) {
    if (!(FACT_KEYS as readonly string[]).includes(key)) continue;
    const actual = bundle.facts[key as keyof Facts];
    if (canonicalJson(actual) !== canonicalJson(p.value)) {
      defects.push({
        code: "provenance_value_mismatch",
        detail:
          `provenance for "${key}" records ${canonicalJson(p.value)} ` +
          `but the facts say ${canonicalJson(actual)}`,
      });
    }
    const expectedSource = FACT_SOURCES[key as keyof Facts];
    if (p.source !== expectedSource) {
      defects.push({
        code: "provenance_value_mismatch",
        detail: `provenance for "${key}" claims source "${p.source}" but the contract says "${expectedSource}"`,
      });
    }
  }

  return { valid: defects.length === 0, defects, rederivedDecision: rederived };
}

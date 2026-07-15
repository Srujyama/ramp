/**
 * @ramp/ledger — simulate.ts (the Policy Simulator backend)
 *
 * A PURE, READ-ONLY "what would policy decide?" probe. It runs the exact same
 * fail-closed evaluation pipeline the hook uses — authoritative DB facts →
 * `translateToFacts` → the injected policy kernel — but stops the instant the
 * kernel has spoken. It is a preview, not a purchase.
 *
 * GUARANTEES (the whole point of this module):
 *   - READ-ONLY: only `LedgerFactSource` reads run (SELECTs). There is NO
 *     `recordDecision`, NO proof persistence, NO execution, and NO INSERT/UPDATE
 *     anywhere on this path. Running a simulation NEVER changes a single ledger row.
 *   - NO DUPLICATED POLICY: it reuses the real `PolicyKernel` (`getKernel().kernel`
 *     by default) and the real fact translator. There is no second policy path here
 *     — same Facts in, same Decision out as the authoritative gate.
 *   - The returned `simulationOnly: true` marker makes it structurally impossible to
 *     mistake a simulation result for a persisted, executed decision.
 */
import {
  translateToFacts,
  type Facts,
  type SpendRequest,
  type DecisionOutcome,
  type RuleId,
  type PolicyKernel,
} from "@ramp/shared";
import { getKernel } from "@ramp/gate";
import { LedgerFactSource } from "./dal.js";
import { policyDigest } from "./policy-digest.js";
import type { LedgerDb } from "./db.js";

/** The untrusted intent to preview. Identity/intent KEYS only — never facts. */
export interface SimulationInput {
  readonly agent: string;
  readonly vendor: string;
  readonly amount: number;
  readonly category: string;
  readonly currency?: string;
  /**
   * Whether to simulate WITH a verified attestation. Defaults to `true`.
   *
   * This exists because pillar 4 and the simulator meet awkwardly, and the
   * awkwardness is worth naming rather than papering over.
   *
   * A simulation is a HYPOTHETICAL: there is no invoice, so there is no
   * attestation to verify, so `attestation_present` would be false — and since
   * `deny/attestation_invalid` (policy.dl D6) denies without one, EVERY
   * simulation would come back "deny: no verified attestation". Technically
   * true, completely useless: it would drown out the question the user actually
   * asked ("am I within my caps?") behind a constant that has nothing to do with
   * their input.
   *
   * So the default models the question people mean: *"assuming the invoice is
   * properly attested, what does policy say?"* `SimulationResult.assumedAttested`
   * reports that assumption back so a caller can never mistake the premise for a
   * finding — the UI must show it. Set `attested: false` to simulate the
   * unattested case explicitly and watch D6 fire.
   */
  readonly attested?: boolean;
}

/**
 * The outcome of a simulation: the kernel's verdict plus the resolved facts it
 * judged and their policy digest. Carries `simulationOnly: true` so it can never
 * be confused with a real, persisted `DecisionRecord`.
 */
export interface SimulationResult {
  /** "allow" | "deny" — the kernel's verdict on the resolved facts. */
  readonly outcome: DecisionOutcome;
  /** The rule ids that fired, in the kernel's frozen evaluation order. */
  readonly firedRules: RuleId[];
  /** Human-readable reasons, one per fired rule. */
  readonly reasons: string[];
  /** The resolved, authoritative facts the kernel actually judged. */
  readonly facts: Facts;
  /** "sha256:<hex>" digest of `facts`, from `policyDigest(facts)`. */
  readonly policyDigest: string;
  /** `input.currency ?? getLimits().currency`. */
  readonly currency: string;
  /**
   * The attestation premise this result was computed under (`input.attested`,
   * default `true`). A simulation has no invoice and therefore no real
   * attestation, so this is an ASSUMPTION, not a finding — and callers must
   * surface it. Reported explicitly so a preview can never be read as evidence
   * that a real payment would be attested. See {@link SimulationInput.attested}.
   */
  readonly assumedAttested: boolean;
  /** Constant marker — a simulation result is ALWAYS a preview, never persisted. */
  readonly simulationOnly: true;
}

/**
 * Preview the policy decision for `input` WITHOUT persisting or executing anything.
 *
 * Pipeline (mirrors the hook, minus every side effect): build a `SpendRequest` from
 * the untrusted input (identity/intent keys), read the AUTHORITATIVE context via
 * `LedgerFactSource.contextFor` (read-only SELECTs), translate to `Facts`, and let
 * the injected `kernel` judge. The kernel is pure/deterministic, so the same input
 * against the same DB state yields the same result — and the real gate would decide
 * identically for the same facts.
 *
 * @throws {Error} if `amount` is not a finite, non-negative number (route → 400).
 */
export function simulate(
  db: LedgerDb,
  input: SimulationInput,
  kernel: PolicyKernel = getKernel().kernel,
): SimulationResult {
  // Validate the ONE numeric intent field. Everything else is a lookup key, so a
  // bad string simply resolves to fail-closed facts (unverified vendor, etc.).
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount)) {
    throw new Error("simulate: amount must be a finite number");
  }
  if (input.amount < 0) {
    throw new Error("simulate: amount must be a non-negative number");
  }

  const factSource = new LedgerFactSource(db);
  // Default the currency label from org limits (a pure read); it is not a gating
  // fact — the kernel judges amounts, not currency codes.
  const currency = input.currency ?? factSource.getLimits().currency;

  // Build the untrusted request from intent keys only (invoiceRef omitted — a
  // simulation references no invoice).
  const request: SpendRequest = {
    vendorId: input.vendor,
    amount: input.amount,
    currency,
    category: input.category,
    requestingAgent: input.agent,
  };

  // AUTHORITATIVE facts (read-only) → closed Facts → the real kernel's verdict.
  // `attestationPresent` is the caller's stated PREMISE here, not a verification
  // result — a hypothetical has no invoice to verify. It is reported back as
  // `assumedAttested` so the premise travels with the answer. Note this is still
  // supplied through the same `AuthoritativeContext` seam the hook uses, so the
  // simulator cannot reach any fact the gate wouldn't.
  const assumedAttested = input.attested ?? true;
  const authoritative = factSource.contextFor({
    request,
    attestationPresent: assumedAttested,
  });
  const facts = translateToFacts(request, authoritative);
  const decision = kernel.evaluate(facts);

  return {
    outcome: decision.decision,
    firedRules: [...decision.firedRules],
    reasons: [...decision.reasons],
    facts,
    policyDigest: policyDigest(facts),
    currency,
    assumedAttested,
    simulationOnly: true,
  };
}

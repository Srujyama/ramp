/**
 * @ramp/provenance — the Node binding (PILLAR 2)
 *
 * All the verification LOGIC lives in verify-core.ts, which is deliberately free
 * of `node:crypto` and takes its sha256 as a parameter. This file is the thin
 * Node binding that supplies it.
 *
 * Why the split: the dashboard re-verifies bundles in the BROWSER, in front of
 * you, using WebCrypto. If the browser had its own verifier, there would be two
 * implementations that could disagree — and "the two verifiers disagree" is the
 * one bug a proof system cannot survive. So there is one verifier and two hosts:
 * `@ramp/provenance` (here, node:crypto) and `@ramp/provenance/core` (browser,
 * WebCrypto). Everything substantive — re-deriving the decision, completeness,
 * honesty — is shared.
 *
 * See verify-core.ts for the argument about what a bundle does and does not prove.
 */
import { createHash } from "node:crypto";
import { canonicalJson, type Facts, type PolicyKernel } from "@ramp/shared";
import {
  buildBundleWith,
  verifyBundleCore,
  type BuildBundleInput,
  type BundleVerification,
  type DecisionBundle,
} from "./verify-core.js";

/** sha256 hex of a string, via node:crypto. */
const sha256: (input: string) => string = (input) =>
  createHash("sha256").update(input, "utf8").digest("hex");

/** sha256 hex of a value's canonical encoding. */
export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Digest of just the facts — the pin an auditor checks first. */
export function digestFacts(facts: Facts): string {
  return digest(facts);
}

/** Assemble and seal a decision bundle. */
export function buildBundle(input: BuildBundleInput): DecisionBundle {
  return buildBundleWith(input, sha256);
}

/**
 * THE AUDITOR'S FUNCTION. Independently verify a decision bundle.
 *
 * Give it a bundle and a kernel; it re-derives the decision from the recorded
 * facts and checks the whole chain. It never touches our database, our process,
 * or our claims — which is exactly why its verdict is worth something.
 */
export function verifyBundle(
  bundle: unknown,
  kernel: PolicyKernel,
): BundleVerification {
  return verifyBundleCore(bundle, kernel, sha256);
}

// Types + the crypto-free core, re-exported so the Node surface is complete.
export {
  BUNDLE_VERSION,
  buildBundleWith,
  verifyBundleCore,
} from "./verify-core.js";
export type {
  DecisionBundle,
  FactProvenance,
  Derivation,
  KernelIdentity,
  BuildBundleInput,
  BundleVerification,
  BundleDefect,
  BundleFailure,
  Sha256Hex,
  UnsealedBundle,
} from "./verify-core.js";

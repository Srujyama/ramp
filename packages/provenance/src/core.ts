/**
 * @ramp/provenance/core — the BROWSER-safe entry point
 *
 * Identical verification logic to `@ramp/provenance`, minus the `node:crypto`
 * import. The caller supplies sha256 (in a browser: WebCrypto via
 * `crypto.subtle.digest`, which is async — so compute the digests first, or use
 * the async helper below).
 *
 * This exists so the dashboard can re-verify a bundle IN FRONT OF YOU using the
 * same code the auditor CLI runs, rather than a second implementation that could
 * drift. Two verifiers that disagree is the one bug a proof system cannot
 * survive.
 *
 * Note the substantive checks need no crypto at all: re-deriving the decision
 * from the recorded facts is just running the (pure, browser-safe) reference
 * kernel, and completeness/honesty are structural. Only the tamper-evidence
 * digests need sha256.
 */
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

export { renderBundle, summarizeBundle, describeDerivation } from "./render.js";

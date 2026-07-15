/**
 * @ramp/provenance — barrel (PILLAR 2: the provenance graph)
 *
 * Content-addressed decision bundles that an auditor can INDEPENDENTLY re-verify:
 * decision -> facts -> each fact's authoritative source.
 *
 * The distinction this package exists to make: an audit log is a claim the
 * system writes about itself, so believing it requires already trusting the
 * thing you are auditing. A bundle is re-derivable — `verifyBundle` re-runs the
 * kernel on the recorded facts and checks the recorded decision falls out. The
 * auditor doesn't trust our gate; they redo the arithmetic.
 *
 * This only works because the kernel is pure and deterministic. Determinism is
 * what makes a decision reproducible, and reproducibility is what makes it
 * provable. This package is the cash-out of that design choice.
 */

export {
  buildBundle,
  verifyBundle,
  digest,
  digestFacts,
  BUNDLE_VERSION,
} from "./bundle.js";
export type {
  DecisionBundle,
  FactProvenance,
  Derivation,
  KernelIdentity,
  BuildBundleInput,
  BundleVerification,
  BundleDefect,
  BundleFailure,
} from "./bundle.js";

// Gate signatures — authenticity ("the gate produced this"), which re-derivation
// cannot give you: a forger can write a NEW, internally perfect bundle. Node-only
// (node:crypto), so deliberately NOT re-exported from ./core.
export {
  signBundleDigest,
  verifyBundleSignature,
  bundleSigningBytes,
  demoGateKeyring,
  demoGatePublicKey,
  demoGatePrivateKey,
  BUNDLE_SIGNING_DOMAIN,
  DEMO_GATE_KEY_ID,
} from "./sign.js";
export type { GateSignature, SignatureVerification, SignatureFailure } from "./sign.js";

export { renderBundle, summarizeBundle, describeDerivation } from "./render.js";

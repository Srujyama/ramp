/**
 * @ramp/dashboard — browser-side bundle verification
 *
 * ============================================================================
 * THE DASHBOARD DOES NOT DISPLAY A CLAIM. IT RE-DERIVES THE ANSWER.
 * ============================================================================
 * Everything on the Proof page is recomputed here, in your browser, from the
 * bundle JSON alone. We do not ask the server whether a decision was valid — we
 * re-run the policy kernel on the recorded facts and check that the recorded
 * decision falls out, then recompute the digests with WebCrypto and check
 * nothing was altered after sealing.
 *
 * That is the entire point of pillar 2, made visible: an audit log is a claim a
 * system makes about itself, so believing it means already trusting the thing
 * you are auditing. A bundle is re-derivable by someone who trusts nothing.
 *
 * Two details that carry the weight:
 *
 *   1. The verification LOGIC is imported from `@ramp/provenance/core` — the
 *      exact module `pnpm proof` runs. Not a browser reimplementation. If the
 *      browser had its own verifier, the two could disagree, and "the verifiers
 *      disagree" is the one bug a proof system cannot survive.
 *   2. The KERNEL is imported from `@ramp/gate/reference` — the real reference
 *      kernel, pure TypeScript, the same golden oracle the gate itself uses. The
 *      browser genuinely evaluates the policy.
 */
import { verifyBundleCore, type BundleVerification, type DecisionBundle } from "@ramp/provenance/core";
import { referenceKernel } from "@ramp/gate/reference";
import { canonicalJson } from "@ramp/shared";

/**
 * sha256 hex via WebCrypto.
 *
 * `crypto.subtle.digest` is async, but `verifyBundleCore` takes a SYNCHRONOUS
 * sha256 (it has to — the kernel it calls is synchronous and pure). So we
 * pre-compute the two digests the verifier will ask for and hand it a lookup.
 * Any input the verifier asks for that we did not anticipate returns a sentinel
 * that cannot match a real digest, so an unexpected question fails CLOSED rather
 * than accidentally passing.
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify one bundle in the browser. Never throws — a failure is a verdict. */
export async function verifyInBrowser(
  bundle: DecisionBundle,
): Promise<BundleVerification> {
  // Pre-compute every digest the core verifier will need, then serve them from a
  // map so the core stays synchronous. The map is keyed by the exact canonical
  // string, so a mismatch is impossible to fake.
  const wanted = new Map<string, string>();

  const factsCanonical = canonicalJson(bundle.facts);
  wanted.set(factsCanonical, await sha256Hex(factsCanonical));

  // Strip `gateSignature` as well as `bundleDigest`: the signature is computed
  // over the digest and attached after sealing, so it cannot be inside it. Must
  // match verify-core's exclusion exactly or the browser and the CLI disagree —
  // and "the two verifiers disagree" is the one bug a proof system can't survive.
  const { bundleDigest: _omit, gateSignature: _sig, ...unsealed } = bundle;
  const unsealedCanonical = canonicalJson(unsealed);
  wanted.set(unsealedCanonical, await sha256Hex(unsealedCanonical));

  const sha256: (s: string) => string = (s) =>
    // Fail closed: a digest we didn't precompute can never equal a real one.
    wanted.get(s) ?? "unavailable-digest-this-will-not-match";

  try {
    return verifyBundleCore(bundle, referenceKernel, sha256);
  } catch (err) {
    return {
      valid: false,
      defects: [
        { code: "malformed", detail: `verifier threw: ${(err as Error).message}` },
      ],
      rederivedDecision: null,
    };
  }
}

/** Fetch the bundles the gate sealed, plus where they came from. */
export async function fetchBundles(): Promise<{
  bundleDir: string;
  bundles: DecisionBundle[];
}> {
  const res = await fetch("/api/bundles");
  if (!res.ok) throw new Error(`GET /api/bundles -> ${res.status}`);
  return res.json();
}

/**
 * @ramp/attestation — signing bytes (domain separation)
 *
 * The canonical encoder itself now lives in @ramp/shared, because
 * @ramp/provenance needs byte-identical encoding too and two copies of a
 * canonicaliser is two chances to drift — where the drift shows up as a
 * security failure rather than a test failure.
 *
 * What stays here is the part that is specific to attestation: DOMAIN
 * SEPARATION. Without it, a signature the notary produced for some OTHER purpose
 * — a login challenge, a billing statement, a different protocol version sharing the key —
 * is a valid signature over bytes that might also parse as an attestation. The
 * prefix means "this key holder signed this, AS a ramp attestation, at this
 * version," so a signature from any other context simply is not over these bytes.
 */
import { canonicalJson } from "@ramp/shared";

/** The domain-separation tag. Changing this invalidates every prior signature — by design. */
export const ATTESTATION_DOMAIN = "ramp.attestation.v1";

/**
 * The exact bytes a notary signs and a verifier checks: the domain tag, a
 * newline, then the canonical statement. Both sides call THIS function — there
 * is deliberately no second way to produce signing bytes.
 */
export function signingBytes(statement: unknown): Buffer {
  return Buffer.from(`${ATTESTATION_DOMAIN}\n${canonicalJson(statement)}`, "utf8");
}

// Re-exported so attestation's public surface is unchanged by the move.
export { canonicalJson };

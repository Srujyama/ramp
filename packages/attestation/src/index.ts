/**
 * @ramp/attestation — barrel (PILLAR 4: TLSNotary-style attestation)
 *
 * Cryptographic proof that invoice bytes were served by the vendor's real domain
 * and signed by a notary we trusted in advance — checked BEFORE money moves,
 * rather than trusting the agent's summary of a document.
 *
 * READ `attestation.ts`'s header, and the README, for an honest statement of the
 * boundary: this implements the verification half with real Ed25519 signatures,
 * canonical domain-separated encoding, and binding checks against the
 * authoritative vendor registry. It does NOT implement the TLSNotary MPC
 * protocol. The guarantee is "a notary we trust signed these bytes, this amount,
 * and this domain together, and nothing has been altered since" — strictly
 * stronger than trusting narration, strictly weaker than real TLSNotary.
 */

export {
  verifyAttestation,
  signAttestation,
  digestInvoice,
  ATTESTATION_VERSION,
} from "./attestation.js";
export type {
  Attestation,
  AttestedStatement,
  AttestationResult,
  AttestationVerified,
  AttestationRejected,
  AttestationFailure,
  AttestationExpectation,
  VerifyOptions,
} from "./attestation.js";

export { canonicalJson, signingBytes, ATTESTATION_DOMAIN } from "./canonical.js";

export {
  demoKeyring,
  keyringFrom,
  productionKeyring,
  demoNotaryPublicKey,
  demoNotaryPrivateKey,
  DEMO_NOTARY_KEY_ID,
} from "./notary.js";

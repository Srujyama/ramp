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
  demoQuorumNotary,
  demoQuorumNotaryKeyId,
  demoQuorumKeyring,
} from "./notary.js";

// Authenticated caller identity: bind the untrusted `requestingAgent` to a
// registered per-agent key, so a request cannot impersonate an agent it was not
// issued a key for. Verified before the id is trusted — see agent-identity.ts.
export {
  signAgentRequest,
  verifyAgentRequest,
  isAgentSignature,
  encodeAgentPublicKey,
  agentPublicKeyFromRegistry,
  demoAgentKeyId,
  demoAgentPrivateKey,
  demoAgentPublicKey,
  signAgentRequestDemo,
  AGENT_REQUEST_DOMAIN,
  AGENT_SIGNATURE_MAX_AGE_MS,
  AGENT_SIGNATURE_SKEW_MS,
} from "./agent-identity.js";
export type {
  SignableRequest,
  AgentRequestSignature,
  AgentAuthResult,
} from "./agent-identity.js";

// K-of-N threshold attestation: no single notary can authorise a payment.
export { verifyQuorum, signQuorum } from "./quorum.js";
export type {
  QuorumAttestation,
  NotarySignature,
  VerifyQuorumOptions,
  QuorumResult,
  QuorumVerified,
  QuorumRejected,
} from "./quorum.js";

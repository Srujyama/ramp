/**
 * @ramp/quarantine — barrel (PILLAR 3: CaMeL-style quarantine)
 *
 * Untrusted content — invoice text, emails, web pages, the model's own narration
 * — is wrapped at the boundary in an opaque {@link Quarantined} that refuses
 * every implicit path to becoming a string. It leaves only through
 * {@link declassify}, which requires a total declassifier whose codomain is
 * small, declared, and countable.
 *
 * The claim this package supports: an attacker with total control of the invoice
 * bytes can move the system only within the codomains we chose in advance. Not
 * "we filter bad strings well" — "bad strings have nowhere to go."
 *
 * See detect.ts for injection heuristics, and read its header before assuming
 * they defend anything: they are telemetry, not a control.
 */

// The wrapper and its boundary.
export {
  Quarantined,
  quarantine,
  isQuarantined,
  QuarantineViolationError,
} from "./quarantine.js";
export type { QuarantineOrigin } from "./quarantine.js";

// The only exit: total declassifiers into bounded codomains.
export {
  declassify,
  asOneOf,
  asBoundedInt,
  asIdentifier,
  asDigest,
} from "./declassify.js";
export type {
  Declassifier,
  DeclassifyResult,
  DeclassifyOk,
  DeclassifyRefused,
  DeclassificationRecord,
  Codomain,
} from "./declassify.js";

// Telemetry (NOT a security control — see detect.ts header).
export { scanForInjection, describeScan } from "./detect.js";
export type { InjectionScan, InjectionMarker } from "./detect.js";

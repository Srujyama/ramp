/**
 * scripts/_lib.mjs — tiny shared helpers for the OPERATOR/AUDITOR scripts.
 *
 * Deliberately minimal. This is imported ONLY by the read-only operator scripts
 * (explain, policy-diff, simulate, stats). It is NOT imported by the fail-closed
 * hook (`hook/evaluate.mjs`), the dependency-free verifier (`verify-ramp-proof.mjs`),
 * or the demo's exit-code assertion path — those stay standalone on purpose. Keep
 * only genuinely-shared, side-effect-free formatting here; the ledger open/close
 * lifecycle stays inline in each script because the scripts differ in how they
 * open (strict vs provisioning) and close (bespoke early-exit paths).
 */

/** Format an integer whole-unit amount as US currency, e.g. 3295 → "$3,295". */
export const money = (n) => `$${Number(n).toLocaleString()}`;

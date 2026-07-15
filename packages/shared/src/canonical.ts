/**
 * @ramp/shared — canonical JSON encoding
 *
 * One value, one byte string. This lives in the shared contract because TWO
 * layers independently depend on bytes being reproducible, and if they can
 * disagree about the encoding, they disagree about everything downstream:
 *
 *   - @ramp/attestation signs and verifies statements. If the signer and the
 *     verifier encode differently, valid signatures fail (or, with a sloppier
 *     scheme, the wrong thing verifies).
 *   - @ramp/provenance content-addresses decision bundles. If the producer and
 *     the auditor encode differently, every honest bundle looks tampered with.
 *
 * Two copies of a canonicaliser is two chances to drift apart, and the drift
 * would show up as a security failure, not a test failure. So: one copy, here,
 * in the package both already depend on.
 *
 * Deliberately dependency-free and free of `node:` imports — @ramp/shared is
 * imported by the browser dashboard too, so anything in here must run in both.
 * (This is why digesting lives in @ramp/provenance, not here: `node:crypto`
 * would break the Vite build.)
 */

/**
 * Deterministically encode a JSON-ish value with recursively sorted object keys.
 *
 * `JSON.stringify` is NOT canonical: object key order follows insertion order,
 * so `{a:1,b:2}` and `{b:2,a:1}` — the same value by any sane reading — produce
 * different bytes. Sorting keys makes the encoding depend only on the VALUE.
 *
 * Arrays keep their order, because order is meaning in an array. Objects do not,
 * because key order is not meaning in an object — which is exactly why it must
 * not be allowed to affect the bytes.
 *
 * Pure and total for JSON-ish input (null, boolean, number, string, array,
 * plain object). Values JSON cannot represent (BigInt, circular refs) are the
 * caller's problem: this function is used on data we constructed ourselves —
 * `Facts`, attestation statements — never directly on untrusted input.
 * @ramp/quarantine's `stableEncode` is the total encoder for that job.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // undefined-valued keys vanish under JSON.stringify; drop them explicitly so
    // both sides agree by rule rather than by relying on that quirk.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" +
    entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") +
    "}"
  );
}

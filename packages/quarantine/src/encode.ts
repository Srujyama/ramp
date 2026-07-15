/**
 * @ramp/quarantine — stableEncode (a TOTAL encoder)
 *
 * Turns any JavaScript value into a string for digesting. The only requirement,
 * and it is absolute: THIS MUST NEVER THROW.
 *
 * Why it's its own file, with its own tests: the naive version was
 * `JSON.stringify(value) ?? String(value)`, and JSON.stringify throws on BigInt
 * and on circular references. That made `quarantine()` — the function you call
 * at the trust boundary, on bytes you did not author — throw for certain inputs.
 *
 * A boundary wrapper that throws is a boundary an attacker can close. Feed the
 * system a BigInt (or a cyclic object) and quarantine() dies before the content
 * is ever wrapped. The hook fails closed, so the money is still safe — but it is
 * an attacker-triggerable crash on the enforcement path, i.e. a denial of
 * service, and it is the exact class of bug the declassifier totality rule
 * exists to prevent. The wrapper's job is to make untrusted input boring, so it
 * had better be total on untrusted input.
 *
 * The encoding is not required to be reversible or canonical across types — it
 * feeds a digest. It only needs to be TOTAL and DETERMINISTIC.
 */

/**
 * Encode any value to a string, without ever throwing.
 *
 * Ordered by specificity: the types JSON.stringify refuses come first, then the
 * general path, then a catch for the structural failures (circularity, hostile
 * getters/toJSON) that no type check can predict.
 */
export function stableEncode(value: unknown): string {
  // Fast path: the overwhelmingly common case.
  if (typeof value === "string") return value;

  // JSON.stringify throws outright on BigInt.
  if (typeof value === "bigint") return `${value.toString()}n`;

  // Symbols: JSON.stringify silently yields undefined; String() throws on
  // implicit coercion but .toString() is safe and descriptive.
  if (typeof value === "symbol") return value.toString();

  // Functions serialise to undefined under JSON; name them instead.
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;

  if (value === undefined) return "[undefined]";
  if (value === null) return "[null]";

  try {
    // Covers objects, arrays, numbers, booleans. May still throw on circular
    // references, or on an object whose toJSON/getter throws — including, quite
    // deliberately, a nested Quarantined (whose toJSON throws by design).
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
    return String(value);
  } catch {
    // Last resort. Deterministic and content-free: two different circular
    // objects collide here, which is fine — a digest collision on unserialisable
    // input costs us nothing, whereas a throw costs us the boundary.
    return `[unserializable ${typeof value}]`;
  }
}

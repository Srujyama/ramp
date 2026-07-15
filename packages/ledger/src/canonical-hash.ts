/**
 * @ramp/ledger — canonical-hash.ts
 *
 * Deterministic content hashing for the audit trail. Node built-ins only
 * (node:crypto) — ZERO new runtime dependencies.
 *
 * Adapted from the reference `canonical-hash.ts` (a C++/OpenSSL kernel port).
 * Two responsibilities:
 *   1. {@link canonicalize} — a stable, whitespace-free JSON serialization with
 *      object keys sorted by code-unit order and array order PRESERVED. Same
 *      value → same bytes on every machine (the RFC 8785 / JCS shape for our
 *      value space: integers + strings + booleans + null, no floats).
 *   2. {@link sha256OfJson} / {@link hashStable} — SHA-256 over the canonical
 *      form, optionally omitting explicitly-documented VOLATILE top-level fields
 *      (e.g. a timestamp) so the digest depends only on meaningful content.
 *
 * Numbers: any FINITE number is accepted and serialized via `String(value)`,
 * which is fully specified (deterministic) in ECMAScript. All Ramp money is whole
 * currency units, but we do NOT throw on a stray fractional value — the audit path
 * must never turn a cosmetic input quirk into a hard failure. Non-finite numbers
 * (NaN/±Infinity) throw, since they have no canonical/JSON form.
 *
 * INTEGRITY, NOT TRUTH: a matching digest proves a record was not altered since
 * it was hashed. It does NOT prove the hashed facts describe reality.
 */
import { createHash } from "node:crypto";

/** The closed value space this module can canonicalize. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { readonly [k: string]: Json };

/**
 * Canonical, whitespace-free serialization. Object keys are sorted (code-unit
 * order); array order is preserved; `undefined`-valued keys are dropped.
 *
 * @throws if a number is non-finite (NaN/±Infinity have no canonical form).
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalize: cannot hash a non-finite number (NaN/Infinity)");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Array ORDER is significant and preserved — never sorted.
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  // Object: sort keys by code-unit order; skip undefined-valued keys.
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as { [k: string]: Json })[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalize(v));
  }
  return "{" + parts.join(",") + "}";
}

/** Lowercase hex SHA-256 of the canonical form (no `sha256:` prefix). */
export function sha256OfJson(value: Json): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** SHA-256 of the canonical form, prefixed `sha256:` — the digest form callers store. */
export function digestOf(value: Json): string {
  return "sha256:" + sha256OfJson(value);
}

/**
 * Stable SHA-256 of an object with the given top-level `volatileKeys` OMITTED.
 * Used to derive an identity that ignores non-meaningful fields (timestamps,
 * latency, the id field itself). Nested occurrences of a volatile key are NOT
 * removed — only the top level, matching the reference semantics.
 */
export function hashStable(
  obj: { readonly [k: string]: Json },
  volatileKeys: readonly string[],
): string {
  const volatile = new Set(volatileKeys);
  const stable: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(obj)) {
    if (volatile.has(k)) continue;
    stable[k] = v;
  }
  return sha256OfJson(stable);
}

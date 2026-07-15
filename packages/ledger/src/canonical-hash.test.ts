/**
 * @ramp/ledger — canonical-hash.test.ts
 *
 * Determinism + tamper-sensitivity of the canonical hasher: key-order
 * independence, array-order sensitivity, volatile-field exclusion, non-finite
 * rejection. Run with `node --test` (Node 24).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  sha256OfJson,
  digestOf,
  hashStable,
} from "./canonical-hash.js";

test("object key order does not change the canonical form", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

test("nested object keys are sorted recursively", () => {
  assert.equal(
    canonicalize({ z: { y: 1, x: 2 }, a: 3 }),
    '{"a":3,"z":{"x":2,"y":1}}',
  );
});

test("array ORDER is significant (never sorted)", () => {
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
});

test("undefined-valued keys are dropped", () => {
  assert.equal(canonicalize({ a: 1, b: undefined as never }), '{"a":1}');
});

test("identical content → identical digest; any change → different digest", () => {
  const a = sha256OfJson({ x: 1, y: ["p", "q"] });
  const b = sha256OfJson({ y: ["p", "q"], x: 1 }); // reordered keys
  assert.equal(a, b);
  assert.notEqual(a, sha256OfJson({ x: 1, y: ["q", "p"] })); // array order
  assert.notEqual(a, sha256OfJson({ x: 2, y: ["p", "q"] })); // value
});

test("digestOf prefixes sha256: and is a 64-hex digest", () => {
  assert.match(digestOf({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test("non-finite numbers throw (no canonical form)", () => {
  assert.throws(() => canonicalize(NaN), /non-finite/);
  assert.throws(() => canonicalize(Infinity), /non-finite/);
});

test("finite floats are accepted and deterministic", () => {
  assert.equal(canonicalize(1.5), "1.5");
  assert.equal(sha256OfJson(0.1 + 0.2), sha256OfJson(0.1 + 0.2));
});

test("hashStable omits the named volatile top-level keys", () => {
  const withT = { id: "x", v: 1, producedAt: 111, latencyMs: 5 };
  const withT2 = { id: "x", v: 1, producedAt: 999, latencyMs: 42 };
  const vol = ["producedAt", "latencyMs"];
  assert.equal(hashStable(withT, vol), hashStable(withT2, vol));
  // A non-volatile change DOES move the stable hash.
  assert.notEqual(
    hashStable(withT, vol),
    hashStable({ ...withT, v: 2 }, vol),
  );
});

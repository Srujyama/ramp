/**
 * @ramp/ledger — policy-digest.test.ts
 *
 * The policy digest is a STABLE "sha256:" identity of the org policy that judged a
 * request. Two guarantees are tested:
 *   1. DETERMINISM — it is sensitive to every org-policy field (per_txn_cap,
 *      daily_limit, approved_categories) and only those.
 *   2. STABILITY — it ignores agent-specific and request-specific facts, so two
 *      decisions under the same org policy share one identity. Run with `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "@ramp/shared";
import { policyDigest, policyDocumentOf } from "./policy-digest.js";

const facts: Facts = {
  request_id: "inv_2026_07_0043",
  requesting_agent: "agent_47",
  amount: 340,
  vendor: "acme_corp",
  category: "office_supplies",
  vendor_verified: true,
  daily_total_so_far: 1140,
  per_txn_cap: 500,
  daily_limit: 1500,
  approved_categories: ["office_supplies", "software", "travel"],
  agent_cleared_categories: ["office_supplies", "software"],
  attestation_present: false,
};

const digest = (f: Partial<Facts>): string => policyDigest({ ...facts, ...f });

test("policyDigest returns a sha256:-prefixed string", () => {
  const d = policyDigest(facts);
  assert.equal(typeof d, "string");
  assert.ok(d.startsWith("sha256:"), `expected sha256: prefix, got ${d}`);
});

test("policyDocumentOf projects exactly the three org-policy fields", () => {
  assert.deepEqual(policyDocumentOf(facts), {
    perTxnCap: 500,
    dailyLimit: 1500,
    approvedCategories: ["office_supplies", "software", "travel"],
  });
});

test("determinism: identical org policy → identical digest", () => {
  assert.equal(policyDigest(facts), policyDigest({ ...facts }));
});

test("sensitivity: changing per_txn_cap changes the digest", () => {
  assert.notEqual(digest({}), digest({ per_txn_cap: 600 }));
});

test("sensitivity: changing daily_limit changes the digest", () => {
  assert.notEqual(digest({}), digest({ daily_limit: 2000 }));
});

test("sensitivity: changing approved_categories changes the digest", () => {
  assert.notEqual(digest({}), digest({ approved_categories: ["office_supplies"] }));
});

test("stability: agent-specific and request-specific facts do NOT change the digest", () => {
  const baseline = digest({});
  assert.equal(baseline, digest({ requesting_agent: "agent_99" }));
  assert.equal(baseline, digest({ amount: 12 }));
  assert.equal(baseline, digest({ vendor: "other_vendor" }));
  assert.equal(baseline, digest({ category: "software" }));
  assert.equal(baseline, digest({ vendor_verified: false }));
  assert.equal(baseline, digest({ daily_total_so_far: 0 }));
  assert.equal(baseline, digest({ request_id: "inv_different" }));
  assert.equal(baseline, digest({ attestation_present: true }));
  assert.equal(
    baseline,
    digest({ agent_cleared_categories: ["office_supplies", "software", "travel"] }),
  );
});

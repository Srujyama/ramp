import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, vendorLabel, vendorDomain, humanizeId, maskedCardNumber } from "./identity.js";

test("known seed ids resolve to their real display names", () => {
  assert.equal(agentLabel("agent_47"), "Procurement Agent 47");
  assert.equal(vendorLabel("acme_corp"), "Acme Corp");
  assert.equal(vendorDomain("acme_corp"), "acme.example.com");
});

test("unknown ids fall back to a humanized label, never blank or raw", () => {
  assert.equal(agentLabel("agent_999"), "Agent 999");
  assert.equal(vendorLabel("brand_new_vendor"), "Brand New Vendor");
  assert.equal(vendorDomain("brand_new_vendor"), null);
});

test("humanizeId splits on underscores/hyphens and title-cases each word", () => {
  assert.equal(humanizeId("agent_47"), "Agent 47");
  assert.equal(humanizeId("multi-word-id"), "Multi Word Id");
  assert.equal(humanizeId(""), "");
});

test("maskedCardNumber is deterministic and pulls the numeric tail from the id", () => {
  assert.equal(maskedCardNumber("agent_47"), "•••• •••• •••• 47");
  assert.equal(maskedCardNumber("agent_47"), maskedCardNumber("agent_47"));
  assert.notEqual(maskedCardNumber("agent_47"), maskedCardNumber("agent_12"));
});

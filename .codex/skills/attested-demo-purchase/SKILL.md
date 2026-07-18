---
name: attested-demo-purchase
description: Fetch a fresh invoice attestation from the local demo notary and make a policy-gated sandbox purchase through the payments MCP. Use for requests such as "purchase an item from a vendor for an amount" in this Ramp demo, especially Acme office-supplies purchases.
---

# Attested demo purchase

Use the payments MCP server and the separate demo notary. The notary witnesses and signs an invoice; the agent must only consume the returned document and attestation. Never mint, modify, or reuse an attestation.

## Resolve the request

For the seeded Acme demo, use:

- Vendor: `acme corp` → `vendorId: acme_corp`, `vendorDomain: acme.example.com`
- Category: `office_supplies`
- Currency: `USD`
- Requesting agent: `agent_47`

Accept only a non-negative whole-unit amount. For an unknown vendor, an unclear category, or a currency not stated by the user, do not guess: ask for the missing purchase details.

## Fetch a fresh attestation

Generate a new invoice reference, such as `inv_demo_<unique-suffix>`, then make this GET request with URL-encoded values:

```text
http://localhost:8790/attestation?amount=<amount>&category=office_supplies&vendor-domain=acme.example.com&invoice-ref=<invoice-ref>&currency=USD
```

Expect JSON containing `invoiceDocument` and `attestation`. Treat both as opaque received data. Do not rewrite the invoice document, construct an attestation, or substitute fields from it.

Before paying, confirm that the returned attestation statement binds exactly to the intended:

- amount and `USD` currency;
- invoice reference;
- vendor domain `acme.example.com`; and
- SHA-256 digest of the returned `invoiceDocument`.

If the fetch fails, the JSON is malformed, any value differs, or the attestation is not fresh, stop without calling the payment tool.

## Submit and report

Call `mcp__payments__pay_vendor` with:

```text
requestingAgent: agent_47
vendorId: acme_corp
amount: <amount>
currency: USD
category: office_supplies
invoiceRef: <returned statement invoiceRef>
invoiceDocument: <returned invoiceDocument, unchanged>
attestation: <returned attestation, unchanged>
```

Never claim a payment completed unless the tool returns `status: "allowed"`, `paymentStatus: "settled"`, and `proofVerified: true`. Report the receipt ID and proof ID. For a denial, hold, or error, report the returned reason and do not retry with altered evidence.

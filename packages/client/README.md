# `@ramp/client` — the typed agent SDK

Build a spending agent on the gate in a few lines. Composes the same pieces the
PreToolUse hook and the MCP tool compose — attestation verification, the
fail-closed purchase lifecycle, the read-only fact source — behind one typed
object.

```ts
import { createRampClient } from "@ramp/client";

const ramp = createRampClient();

// Ask before you spend.
const budget = ramp.budget("agent_47");
//    { spentToday: 1140, remainingToday: 360, maxUnattendedNow: 360, ... }

// Preview the outcome without spending a cent.
ramp.preview({ requestingAgent: "agent_47", vendorId: "acme_corp",
               amount: 340, category: "office_supplies" });
//    { outcome: "allow", assumedAttested: true, ... }

// Make a provable payment.
const r = await ramp.pay(spendRequest);
if (r.status === "allowed")      { /* settled, proof verified */ }
else if (r.status === "escalated") { /* HELD — poll ramp.approval(r.decisionId) */ }
else                             { /* denied — r.reasons says why */ }

ramp.close();
```

## It is a convenience, not the enforcement boundary

The non-bypassable gate is the **PreToolUse hook**. The SDK *reuses the same
lifecycle*, so a payment made through it is judged identically — it runs the same
`verifyAttestation` and the same `requestPurchase` as everything else, one
verifier, one lifecycle, no second opinion. But an agent that skips the SDK and
calls a raw payment tool is **still caught by the hook**. The SDK makes the honest
path easy; it does not make the dishonest path possible. There's a test asserting
exactly that (an unattested request through the SDK is denied, not waved through).

## API

| Method | What it does | Writes? |
| --- | --- | --- |
| `pay(request)` | Verify attestation → drive the fail-closed lifecycle. Returns the full result. | yes (a decision) |
| `preview({...})` | Real kernel, zero side effects. States its attestation premise. | no |
| `budget(agent)` | Headroom today. Throws for an unknown agent (fail-closed). | no |
| `approval(id)` | A human's verdict on a held decision, or `null`. | no |
| `decisions(limit)` | Recent decisions from the append-only log. | no |
| `withDemoAttestation(req)` | **Demo/test only** — mint a valid attestation using the public demo notary. | no |

`createRampClient({ executor })` injects a real payment executor; the default is a
deterministic sandbox that moves no money. `withRampClient(opts, fn)` closes the
handle for you.

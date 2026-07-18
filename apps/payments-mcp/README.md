# @ramp/payments-mcp — the enforcing payments MCP server

**Provable Agent Spend** is authorization infrastructure for AI-agent payments:
a decision-verification layer that sits beneath any agentic payment platform
(including Ramp's) as complementary infrastructure. Platforms prove *who
authorized* a payment; this layer proves *the authorization decision itself was
correct given authenticated facts* — independently verifiable. This package is
its agent-facing surface: a [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes one tool, **`pay_vendor`** (full MCP name
**`mcp__payments__pay_vendor`**), over stdio.

An agent does not "pay" directly. It **requests** a purchase. The server is
**self-enforcing** — the second independent gate over the same authorization
kernel as the PreToolUse hook — and runs the full provable-spend lifecycle
before any payment is attempted:

- **Authenticated** — the request's Ed25519 `identity` signature is verified
  against the ledger's **agent registry** (authoritative public keys,
  active/revoked status); the result is the authenticated fact
  `agent_identity_verified`, and the kernel denies unauthenticated or
  impersonated requests via `deny/unauthenticated_agent`.
- **Policy-controlled** — the request is decided by the deterministic authorization
  kernel (`@ramp/gate`) against **authenticated** facts read from the ledger
  (`@ramp/ledger`), never from the model's narration.
- **Tamper-evident** — every decision is persisted with a proof whose id is derived
  from its content, so a tampered record is detectable.
- **Independently verifiable** — the authorization proof is re-verified from the
  persisted record *before* any money-movement is attempted, and can be re-verified
  again out-of-band from the shell.
- **Traceable** — a trusted provenance graph is derived for each decision, and the
  audit trail is exposed read-only over HTTP.

> **Sandbox only.** No real money moves. No payment provider is configured. The
> executor behind this server is a deterministic **sandbox** (`SandboxExecutor`) that
> mints simulated settlement records. See
> [Payment-executor boundary](#payment-executor-boundary).

---

## Supported MCP clients

The **same** MCP server binary works for every client — only the client-side
registration format differs. Per-client setup guides live in
[`mcp-clients/`](./mcp-clients/):

| Client | Config guide |
| --- | --- |
| Claude Code | [`mcp-clients/claude-code.md`](./mcp-clients/claude-code.md) |
| Codex | [`mcp-clients/codex.md`](./mcp-clients/codex.md) |
| Cursor | [`mcp-clients/cursor.md`](./mcp-clients/cursor.md) |
| Generic stdio | [`mcp-clients/mcp.example.json`](./mcp-clients/mcp.example.json) |

There is no client-specific server code — it is one stdio server for all of them.

---

## Install & startup

```bash
# from the repo root — build every workspace package (compiles this server to dist/)
pnpm -r build
# or just this app:  pnpm --filter @ramp/payments-mcp build

# start the server (stdio transport)
pnpm --filter @ramp/payments-mcp start        # → node dist/server.js
# root shortcut:  pnpm mcp

# or run the TypeScript directly during development
pnpm dlx tsx apps/payments-mcp/src/server.ts
```

The server speaks JSON-RPC on **stdout/stdin**; diagnostics go to **stderr** so they
never corrupt the protocol stream. The tool appears to the agent as
**`mcp__payments__pay_vendor`**.

Most MCP clients launch the server themselves from your config file — you do not
usually run `start` by hand except to smoke-test the build.

### Environment variables

No payment-provider credentials are required, because the executor is a sandbox and
no real provider is configured. Everything is optional and has a safe default:

| Var | Default | Effect |
| --- | --- | --- |
| `RAMP_KERNEL` | *(unset)* | Set to `wasm` to select the wasm-backed kernel **iff** the compiled artifact (`wasm/pkg`) is resolvable; otherwise the always-available TypeScript **reference kernel** is used. Leave unset for the reference kernel. |
| `RAMP_DB_PATH` | `ramp.db` | Path to the SQLite audit ledger. **Honored by the server** (as well as the bridge and the `verify-proof` CLI): set it to one absolute path so all three read/write the **same** file. Unset → `ramp.db` relative to the process working directory. |
| `RAMP_FAIL_VENDORS` | *(unset)* | Comma-separated `vendorId`s the sandbox executor should return a **failed** settlement record for. Lets a live server deterministically demo the `executor_error` path (allowed + persisted + verified, then the payment fails) with no real provider and no secret. It can only make an allowed payment fail — never turn a deny into a payment. |

```bash
# .env.example — copy, adjust, and DO NOT commit real values.
# All optional. No secrets, no provider credentials — the executor is a sandbox.
# RAMP_KERNEL=wasm                 # opt into the wasm kernel if the artifact is built
# RAMP_DB_PATH=/ABSOLUTE/PATH/TO/ramp/ramp.db   # shared ledger path (placeholder!)
# RAMP_FAIL_VENDORS=acme_corp      # demo: force the sandbox executor to fail for these vendors
```

---

## The purchase lifecycle

`pay_vendor` delegates to `requestPurchase` (in `@ramp/ledger`), which runs a strict,
**fail-closed** sequence. The executor is **last** and **conditional** — it only ever
runs for a request that has already been allowed, persisted, and independently
verified:

```
agent request
  → isSpendRequest guard            (invalid → policy_error, NO execution)
  → verify Ed25519 agent identity   (vs the ledger agent registry → agent_identity_verified fact)
  → authoritative facts             (ledger read; throw → policy_error)
  → kernel.evaluate(facts)          (authorization decision; unauthenticated → deny; throw → policy_error)
  → derive trusted provenance       (throw → policy_error)
  → build tamper-evident proof      (throw → policy_error)
  → persist decision + proof        (conflict/throw → audit_error, NO execution)
  → re-read + INDEPENDENTLY verify  (!verified → audit_error, NO execution)
  → if decision == "deny"           → denied, NO execution, NO settlement
  → else execute sandbox payment    (throw / status "failed" → executor_error)
  → structured settlement record or denial
```

**Fail-closed is the whole point.** Any failure to gather facts, decide policy, build
provenance, build the proof, persist the decision, or re-verify the proof results in
**no execution**. A denial results in no execution. Money movement (in the sandbox
sense) happens on exactly one path: allowed **and** persisted **and** re-verified.

---

## The `pay_vendor` tool

### Input

The `SpendRequest` fields plus three optional, non-authoritative fields:

| field | type | notes |
| --- | --- | --- |
| `vendorId` | `string` | vendor to pay, e.g. `"acme_corp"` |
| `amount` | `integer ≥ 0` | whole currency units; non-integer / negative is rejected at the zod boundary and re-guarded |
| `currency` | `string` | ISO 4217, e.g. `"USD"` |
| `category` | `string` | spend category, e.g. `"office_supplies"` |
| `requestingAgent` | `string` | agent id, e.g. `"agent_47"` — **a key, not a credential**; authenticated via `identity` |
| `identity` | `{ scheme: "ed25519", signature }` | the agent's Ed25519 signature over the canonical identity core of the request (`vendorId`, `amount`, `currency`, `category`, `invoiceRef`, `requestingAgent`); verified against the ledger's **agent registry** (active keys only). Missing/invalid/revoked → `agent_identity_verified: false` → `deny/unauthenticated_agent`. The SDK (`createRampClient`) signs automatically. |
| `invoiceRef` | `string` (opt) | invoice / attestation reference |
| `reason` | `string` (opt) | human-readable rationale; **provenance / UX only**, never a policy input |
| `toolCallId` | `string` (opt) | optional trusted provenance node; omit if not genuinely present |
| `taskId` | `string` (opt) | optional trusted provenance node; omit if not genuinely present |

### Response schema

The tool returns `structuredContent` (and a `text` mirror = `JSON.stringify` of it).
There are three shapes.

**ALLOW** — policy allowed, decision persisted and verified, sandbox payment settled:

```jsonc
{
  "status": "allowed",
  "decisionId": "dec_…",
  "requestId": "…",            // correlation label = facts.request_id (invoiceRef) or decisionId
  "executionId": "exec_…",     // from the settlement record; execution-scoped, NOT a policy-correlation id
  "vendor": "acme_corp",
  "amount": 40,
  "currency": "USD",
  "policyOutcome": "allow",
  "firedRules": ["…"],
  "proofId": "proof_…",
  "proofVerified": true,
  "paymentStatus": "settled",  // = settlement-record status
  "settlementId": "rcpt_…",    // provider settlement id
  "message": "Payment settled: 40 USD to acme_corp (rcpt_…)"
}
```

**DENY** — policy denied; **no payment, no settlement id, no executionId**:

```jsonc
{
  "status": "denied",
  "decisionId": "dec_…",
  "policyOutcome": "deny",
  "firedRules": ["daily_limit_exceeded"],
  "proofId": "proof_…",
  "proofVerified": true,        // the DENY decision is still persisted + proven
  "reason": "daily spend limit exceeded; vendor not verified",  // reasons joined with "; "
  "message": "Denied: …"
}
```

A deny is a fully persisted, proven, verifiable decision — it just never touches the
executor. `proofVerified: true` on a deny means "we proved that we denied", not "we
paid".

**ERROR** — one of `policy_error` / `audit_error` / `executor_error`:

```jsonc
{ "status": "audit_error", "decisionId": "dec_…" | null, "message": "…" }
```

`audit_error` and `executor_error` (and invalid-input `policy_error`) also set
`isError: true`. The four failure classes are distinguished by `status`:

| status | meaning | executed? |
| --- | --- | --- |
| `policy_error` | invalid input, or facts/kernel/provenance/proof construction failed | no |
| `audit_error` | persisting the decision failed, or the proof did not re-verify | no |
| `executor_error` | allowed + persisted + verified, but the executor threw or returned `failed` (decision stays persisted) | attempted |

No response — allow, deny, or error — ever contains secrets or credentials.

---

## Payment-executor boundary

`requestPurchase` calls an injected `PaymentExecutor`; this server injects
`makeSandboxExecutor()`. The interface is deliberately small:

```ts
interface PaymentExecutor {
  // returns a settlement record ({ settlementId, executionId, status, provider, executedAt })
  execute(req: ExecutorRequest): Promise<SettlementRecord> | SettlementRecord;
}
```

**SANDBOX ONLY.** The `SandboxExecutor` is deterministic and mints simulated
settlement records. **No real money moves and no real payment provider is configured
anywhere in this repo.**

A real adapter (Stripe, the Ramp API, …) would implement the **same**
`PaymentExecutor` interface and be injected in place of the sandbox — this layer is
authorization infrastructure *beneath* whatever platform actually moves the money,
not a replacement for it. The adapter would read its credentials from server-side
environment configuration and **never** surface them to the agent, the tool
response, or the settlement record. The agent-facing contract would not change.

---

## Settlement-record semantics

A settlement record carries two ids with different meanings — do not conflate them:

- **`settlementId`** — the provider **settlement id** (`rcpt_…`). In the sandbox it is a
  deterministic hash of the decision + request fields, so identical requests yield
  identical settlement ids (idempotent retries collapse).
- **`executionId`** — an **execution-scoped** id (`exec_…`), derived deterministically
  from the decisionId. It marks *this execution* of the payment. It is **NOT a
  policy-correlation id** — do not use it to tie a decision back to a policy evaluation.

The settlement record never contains card numbers, API keys, or provider credentials.

---

## Correlation-id limitation (honest)

- On the **MCP tool path**, a single `decisionId` is minted inside `requestPurchase`
  and propagates through policy → ledger → proof → execution → settlement record. That
  gives you end-to-end correlation *within a tool call*.
- Under **Claude Code**, the repo also ships a `PreToolUse` hook
  (`.claude/hooks/evaluate.mjs`) that **independently** evaluates the same request and
  writes its own audit entry **before** the tool runs. The hook and the tool are two
  **independent** audit entries — defense in depth. There is **no shared native id**
  (no `tool_use_id`) linking the hook's evaluation to the tool's `decisionId`.

We do **not** claim end-to-end hook ↔ tool correlation. Treat them as two independent
enforcement layers that happen to reach the same fail-closed conclusion.

---

## Trust boundaries & security limitations

- **Model narration is never a fact.** The agent's free-text (including `reason`) is
  never a policy input. Security-critical facts (caps, daily totals, vendor
  verification, cleared categories) come only from the authoritative ledger.
- **A proof proves integrity, not truth.** `proofVerified: true` means the persisted
  decision has not been tampered with — it does **not** assert that the underlying
  facts were "correct", only that the recorded decision is internally consistent and
  unaltered.
- **Attestation is labeled honestly.** Proof attestation status is `absent` or
  `present_unverified` — never `"verified"` unless a real verification check exists.
  The absence of an invoice/attestation is stated plainly, not papered over.
- **The sandbox executor is not a real charge.** A settled sandbox settlement record
  is a simulation.

---

## Out of scope — this layer complements platforms, it does not compete with them

This layer verifies and records agent-spend **authorization decisions**. Product
features like forecasting, analytics, reimbursement flows, approval queues, card
programs, and real payment rails belong to agentic payment platforms (Ramp among
them) — this layer deliberately provides none of that and sits **beneath** such
platforms as complementary infrastructure. A platform proves *who authorized* a
payment; this layer proves *the authorization decision itself was correct given
authenticated facts*, and makes that proof independently verifiable. Policy is
authored in `@ramp/gate`; authenticated facts live in `@ramp/ledger`.

## Future: real-provider integration

Swapping the sandbox for a real provider is a single, contained change: implement
`PaymentExecutor` against the provider's API, load credentials server-side from env,
keep them out of every response and settlement record, and inject that executor where
`makeSandboxExecutor()` is used today. The lifecycle, the fail-closed guarantees, and
the agent-facing response schemas stay identical.

---

## Demo walkthrough

A numbered end-to-end demo. Run everything from the **repo root** (or set
`RAMP_DB_PATH` to one shared path) so the server, bridge, and CLI all read the same
`ramp.db`.

1. **Build.** `pnpm -r build` — compiles the server, the ledger, and the gate.
2. **Register / start the server.** Register `payments` in your MCP client (see
   [`mcp-clients/`](./mcp-clients/)), or smoke-test with
   `pnpm --filter @ramp/payments-mcp start`.
3. **Allowed purchase.** From the agent, call `mcp__payments__pay_vendor` with a
   within-policy request (verified vendor, under cap, cleared category, signed
   agent identity). Expect `status: "allowed"`, a `settlementId`,
   `paymentStatus: "settled"`, and `proofVerified: true`. Note the returned
   `decisionId`.
4. **Denied purchase.** Call `pay_vendor` with an over-limit or unverified-vendor
   request. Expect `status: "denied"`, `firedRules` naming the rule(s), **no
   `settlementId`**, and still `proofVerified: true`. Note this `decisionId` too.
5. **Start the read-only audit bridge.** `pnpm --filter @ramp/ledger bridge`
   (defaults to `http://localhost:8787`; honors `PORT`, `RAMP_DB_PATH`,
   `RAMP_BRIDGE_ORIGIN`). It is **GET-only** — there is no mutation route.
6. **List decisions.** `GET http://localhost:8787/decisions` — both the allow and the
   deny appear in the append-only trail.
7. **Inspect one decision.** `GET http://localhost:8787/decisions/<decisionId>` — the
   persisted decision with its outcome and proof.
8. **Independently verify the allow.**
   `pnpm --filter @ramp/ledger verify-proof <allow-decisionId>` — read-only; recomputes
   the proof id from stored content. Expect `proofVerified: true` and exit code `0`.
9. **Independently verify the deny.**
   `pnpm --filter @ramp/ledger verify-proof <deny-decisionId>` — a denied decision is
   persisted and proven too, so this also verifies (exit `0`). Tampering with the
   record would flip it to a mismatch (non-zero exit), which is the point.

`verify-proof` reads `$RAMP_DB_PATH` or `./ramp.db` and never writes. Its exit codes
are meaningful (`0` ok, `3` not found, `4` no proof, `5` corrupt, `6` mismatch), so it
composes in CI.

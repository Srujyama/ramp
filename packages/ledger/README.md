# @ramp/ledger

The **authoritative fact source** and **audit trail** for Provable Agent Spend.
Reads security-critical facts from SQLite (never from model narration) and
persists every policy decision with a tamper-evident proof and independently
derived provenance.

This package is **neil-owned** (`/packages/ledger/` in CODEOWNERS). Its proof
and provenance types are deliberately **local** to this package — the frozen
`@ramp/shared` contract (`SpendRequest` / `Facts` / `Decision`) is never touched.

---

## What's here

| Area | Module | Summary |
|------|--------|---------|
| Fact source | `db.ts`, `dal.ts` | Open the SQLite store; anti-injection authoritative reads. |
| Audit trail | `decision-log.ts` | `recordDecision` / `getDecision` / `listDecisions` — append-only, idempotent, keyset-paginated. |
| Proof | `proof.ts` | `buildProof` / `verifyProof` — stable `proof_<sha256>` identity over the meaningful content. |
| Canonical hash | `canonical-hash.ts` | Deterministic JSON canonicalization (node:crypto only). |
| Provenance validation | `provenance.ts` | Bounded, pure DAG validator (structural, not authenticity). |
| **Provenance capture** | `provenance-builder.ts` | **Deterministically DERIVE a provenance DAG from trusted context.** |
| **Independent verification** | `proof-verification.ts` | **Recompute a decision's proof — never trust stored bytes.** |
| **Verify CLI** | `cli/verify-proof.ts` | **`verify-proof <decisionId>` — re-verify from the shell, read-only.** |
| **Read-only HTTP bridge** | `http-bridge.ts` | **`GET /decisions`, `GET /decisions/:id` — surface the audit trail to the dashboard.** |

The **bold** rows are the three features added in this task. The rest is the
Phase-F audit-trail foundation they build on.

---

## 0. Purchase lifecycle (`purchase.ts` → `requestPurchase`)

The shared, fail-closed purchase lifecycle lives **here**, in `@ramp/ledger`, so both
the enforcing MCP tool (`apps/payments-mcp`) and any other caller run the identical
sequence. `requestPurchase(input)` takes an injected kernel, fact source, ledger
handle, and `PaymentExecutor`, and runs (strict order, executor last and conditional):

1. `isSpendRequest` guard — invalid → `policy_error`, no execution.
2. Authoritative facts via `factSource.contextFor` + `translateToFacts` — throw → `policy_error`.
3. `kernel.evaluate(facts)` — throw/malformed → `policy_error`.
4. Mint `decisionId` (= `idempotencyKey` if given, else `dec_<sha256>`); `requestId` = `facts.request_id` or `decisionId`.
5. `buildDecisionProvenance(...)` — throw → `policy_error`.
6. `buildProof(...)` with honest attestation (`present_unverified` / `absent`) — throw → `policy_error`.
7. `recordDecision(...)` — conflict/throw → `audit_error`, no execution.
8. Re-read + `verifyDecisionProof` — not verified → `audit_error`, no execution.
9. If `deny` → `denied`, no execution, no receipt.
10. Else `executor.execute(...)` — throw / `status:"failed"` → `executor_error` (decision stays persisted); else `allowed` with receipt.

`requestPurchase` contains **no policy logic** of its own — it delegates to the injected
kernel (not a second policy path) and never logs or returns secrets. Full input/output
shapes and the `pay_vendor` response schemas are documented in
[`apps/payments-mcp/README.md`](../../apps/payments-mcp/README.md).

---

## 1. Read-only HTTP bridge (`http-bridge.ts`)

A minimal read-only API built on **`node:http` only** (no Express/Fastify). It
is the trust boundary between an untrusted browser and the authoritative store,
so it is deliberately narrow: **GET-only, no mutation route exists.** The ledger
is written **only** by the enforcement path (the hook and the `requestPurchase`
tool path) — never by the bridge; a bridge that could write would be a way to
forge audit rows, so it simply cannot.

### Construction

```ts
import { openLedger, createLedgerBridge } from "@ramp/ledger";

const db = openLedger("ramp.db", { provisionIfEmpty: false });
const server = createLedgerBridge({
  db,                                   // injected; the bridge never opens/closes it
  allowedOrigin: "http://localhost:5173", // the ONE dashboard origin (never "*")
  maxUrlLength: 2048,                   // optional (default 2048) → 414 past this
  maxBodyBytes: 0,                      // optional (default 0)    → 413 past this
});
server.listen(8787);
// ... later: server.close(); (the caller owns the lifecycle)
```

`createLedgerBridge` **never** calls `listen()` and **never** opens/closes the
DB — the caller owns both, which keeps it trivially testable and leak-free.

### Env-driven launcher

`pnpm --filter @ramp/ledger bridge` runs `startLedgerBridge()`, which reads:

| Env var | Default | Meaning |
|---------|---------|---------|
| `RAMP_DB_PATH` | `ramp.db` | Ledger DB path. |
| `RAMP_BRIDGE_ORIGIN` | `http://localhost:5173` | Allowed CORS origin. |
| `PORT` | `8787` | Listen port. |

Importing the module never starts a server (the launch is guarded by a
direct-invocation check).

### Routes

| Method + path | Status | Body |
|---------------|--------|------|
| `GET /decisions` | 200 | `{ "decisions": DecisionView[], "nextCursor"?: string }` |
| `GET /decisions/:id` | 200 / 404 | `DecisionView` / `{ "error": "not_found" }` |
| `OPTIONS *` (preflight) | 204 | — (`Access-Control-Allow-Methods: GET, OPTIONS`) |
| any other method | 405 | `{ "error": "method_not_allowed" }` + `Allow: GET, OPTIONS` |
| unknown path | 404 | `{ "error": "not_found" }` |

**`GET /decisions` query filters** (all optional, unknown params ignored):
`agentId`, `vendorId`, `outcome` (`allow`\|`deny`), `status`
(`allowed`\|`denied`\|`error`), `firedRule`, `since`, `until`, `limit`, `cursor`.

Pagination is **keyset** (`nextCursor`), newest-first, and **bounded**:
`listDecisions` clamps `limit` to `[1, 200]` (`MAX_LIMIT`). Pass `cursor` from a
prior page's `nextCursor` to fetch the next page.

### `DecisionView` response format

The full stored `DecisionRecord` — `decisionId`, `requestId`, `status`,
`outcome`, `agentId`, `vendorId`, `amount`, `category`, `attestationPresent`,
`kernelId`, `request`, `facts`, `decision`, `firedRules`, `proof`, `ts`,
`corrupt` — **plus three derived trust fields**:

| Field | Meaning |
|-------|---------|
| `provenance` | `proof.provenance` surfaced top-level (`null` when absent). |
| `proofVerified` | **Independently recomputed** boolean — *not* the stored bytes. |
| `proofVerification` | `{ proofPresent, proofVerified, expectedProofId, actualProofId, reason }` where `reason ∈ "ok" \| "absent" \| "corrupt" \| "mismatch"`. |

### Security / robustness

- **CORS pinned to one origin, never `*`.** `Access-Control-Allow-Origin` is set
  **only** when the request `Origin` exactly equals `allowedOrigin`; a rejected
  origin is never echoed (`Vary: Origin` is always sent).
- **Request-size protection:** any body over `maxBodyBytes` (default 0) → 413,
  and the stream is drained. It is a GET API — no body is ever read.
- **URL length cap:** `req.url` over `maxUrlLength` → 414.
- **Bounded queries:** pagination is delegated to `listDecisions`; no unbounded
  reads.
- **No info leak:** a malformed cursor → 400 `bad_request`; a bad `limit` → 400;
  everything else unexpected → 500 `internal_error`. A **stack trace, SQL, DB
  text, or file path is never written to a response.**

### Corruption & proof semantics on the wire

- A row whose stored JSON failed to parse comes back with `corrupt: true` and a
  nulled `proof` — the endpoint still returns **200** (it never crashes on bad
  data), and `proofVerified` is `false`.
- A present-but-tampered proof → `proofVerified: false`, `reason: "mismatch"`.
- A missing proof → `proofVerified: false`, `reason: "absent"` (a missing proof
  is **never** represented as verified).

---

## 2. Independent proof verification (`proof-verification.ts` + CLI)

### Helper

```ts
import { verifyDecisionProof } from "@ramp/ledger";

const v = verifyDecisionProof(record); // record: { proof: LedgerProof | null }
// → { proofPresent, proofVerified, expectedProofId, actualProofId, reason }
```

It **recomputes** the proof id from the stored content via `verifyProof` and
compares — it **never trusts the stored `proofId` bytes**. It **never throws**:

| Situation | `proofVerified` | `reason` |
|-----------|-----------------|----------|
| present, recomputes to stored id | `true` | `"ok"` |
| present, recomputes to a different id (tampered) | `false` | `"mismatch"` |
| present but content corrupt/malformed (recompute throws) | `false` | `"corrupt"` |
| no proof stored | `false` | `"absent"` |

### CLI — `verify-proof <decisionId>`

```bash
pnpm --filter @ramp/ledger verify-proof <decisionId>
# or, inside packages/ledger:  pnpm verify-proof <decisionId>
# DB path: $RAMP_DB_PATH (default ./ramp.db). READ-ONLY — never mutates the ledger.
```

Loads the stored decision + proof, recomputes verification **independently**,
prints a concise human-readable result, and exits with a meaningful code:

| Exit | Meaning |
|------|---------|
| `0` | Proof present **and** independently re-verified. |
| `1` | Unexpected/internal error (e.g. ledger could not be opened). |
| `2` | Missing/empty `decisionId` argument. |
| `3` | No decision with that id. |
| `4` | Decision exists but has **no proof**. |
| `5` | Proof present but **corrupt** (recompute threw). |
| `6` | Proof present but recomputes to a **different id** (tampered/invalid). |

The CLI opens the ledger with `provisionIfEmpty: false` and always closes it; it
performs **no writes**. Its core (`runVerifyProof` / `verifyProofResultFor`) is a
pure function of the record, so every exit path is unit-tested without spawning a
process.

---

## 3. Trusted provenance capture (`provenance-builder.ts`)

`buildDecisionProvenance` **derives** a provenance DAG from **trusted execution
context only** and hands it to `buildProof` (which validates it and folds it into
the proof hash). There is **no `provenance` channel in the input** — an agent can
never hand us a graph to embed.

```ts
import { buildDecisionProvenance } from "@ramp/ledger";

const graph = buildDecisionProvenance({
  request,      // SpendRequest — used only as fallback KEYS, never as facts
  decision,     // the exact kernel Decision
  facts,        // AUTHORITATIVE Facts the kernel evaluated (optional)
  kernelId,     // getKernel().kind (optional)
  toolCall,     // { id, name? } — ONLY when a genuine tool-call id exists
  taskChainId,  // string — ONLY when a genuine upstream task id exists
});
```

### Derivation model (the trusted chain of events)

Nodes are emitted in a **fixed deterministic sequence**; optional nodes appear
**only** when their value genuinely exists (never fabricated):

1. `request_received` (`task`) — metadata `request_id`/`agent` read from
   **authoritative facts** when present (request fields are fallback keys only).
2. `facts_src:<source>` (`arg`) — one per **distinct** trusted fact-source that
   actually contributed a fact, derived from `@ramp/shared`'s `FACT_SOURCES`,
   **sorted alphabetically** (`attestation`, `ledger_db`, `policy_config`,
   `tool_args`, `vendor_registry`). Present only when `facts` is supplied.
3. `facts_loaded` (`derived`) — present only when `facts` is supplied.
4. `policy_evaluated` (`derived`) — metadata `kernelId` when known.
5. `decision_produced` (`derived`) — metadata `outcome` + fired-rule count.
6. `action_allowed` **or** `action_denied` (`derived`) — per the decision.
7. `task_chain:<id>` (`task`) — only when `taskChainId` is supplied.
8. `tool_call:<id>` (`tool_call`) — only when `toolCall` is supplied.

Edges (fixed sequence): `request_received → facts_loaded`, each
`facts_src:<source> → facts_loaded`, `facts_loaded → policy_evaluated`,
`policy_evaluated → decision_produced`, `decision_produced → action_*`. When
`facts` is absent, the first three collapse to `request_received →
policy_evaluated`. Optional `task_chain`/`tool_call` nodes edge **into**
`request_received`.

A live allow/deny with full facts yields **10 nodes / 9 edges**.

### Guarantees

- **Deterministic** — no `Date.now()`, no `Math.random()`, no key-insertion
  nondeterminism. Identical input → byte-identical `nodes` and `edges`.
- **Trust-only** — provenance is reconstructed from trusted inputs; agent-claimed
  values are never authoritative. Optional tool/task nodes appear only when real.
- **Structurally valid** — the graph always passes `validateProvenance` (acyclic,
  endpoints exist, within `PROVENANCE_LIMITS`). The builder does not call the
  validator itself; `buildProof` does, before persistence.
- **Hash-sensitive** — provenance is part of the proof's stable content, so any
  provenance change moves the `proofId`.

### Hook integration & fail-closed behavior

The PreToolUse hook (`.claude/hooks/evaluate.mjs`, mirrored to
`hook/evaluate.mjs`) is the only holder of the exact request + authoritative
facts + decision, so it is where provenance is derived. In step 4b it calls
`buildDecisionProvenance({ request, decision, facts, kernelId })` and passes the
graph to `buildProof`. This sits **inside the existing fail-closed audit block**:
if provenance construction is unavailable, or the derived graph is invalid (so
`buildProof` throws), the block **denies** exactly like an audit-write failure —
an un-provable allow is never persisted with an incomplete proof. Live decisions
now persist **non-null** provenance; **historical rows are never back-filled.**

---

## Testing

```bash
pnpm --filter @ramp/ledger test   # tsc -b then node --test over dist/**/*.test.js
```

Suite (all green): **117 tests** — including the audit-trail, proof, canonical
hash, and provenance-validator suites plus the three features added here
(provenance builder 13, proof verification 11, HTTP bridge 19).

---

## Limitations & future work

- **Structural, not authentic.** A valid proof means the *record* was not
  altered; a valid provenance DAG means it is *well-formed*. Neither asserts the
  underlying facts are true or that any attestation passed —
  `AttestationStatus` reports that honestly (`present_unverified` at the hook,
  never `verified`, because no verification result exists there yet).
- **No tool-call / task-chain nodes at the hook yet.** There is no native
  `tool_use_id` shared between the hook and the MCP tool, so those optional
  provenance nodes are omitted (never fabricated). If a trusted correlation id
  becomes available, pass it as `toolCall` / `taskChainId`.
- **Bridge is read-only by design** and single-DB; it does no auth beyond CORS
  origin pinning (it is meant to sit behind the dashboard, not the public net).
- **Historical rows** keep `provenance: null` — only decisions recorded after
  this change carry a derived graph.

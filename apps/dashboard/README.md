# @ramp/dashboard

The **read-only audit console** for **Provable Agent Spend** — the trust layer
between AI agents and money. Every autonomous purchase is policy-controlled,
recorded, traceable, and independently verifiable, and this console lets a human
see and *independently confirm* all of it.

It **enforces nothing**. The security boundary is the deterministic policy gate
and the Claude Code `PreToolUse` hook. This app only reads the append-only
decision log through the read-only `@ramp/ledger` HTTP bridge (`GET /decisions`,
`GET /decisions/:id`) and never writes.

See [`PRODUCT.md`](PRODUCT.md) for the narrative and [`DESIGN.md`](DESIGN.md) for
the visual system.

## Routes

| Route | Page | What it shows |
|---|---|---|
| `/` | **Overview** | Value-prop hero, the 6-step workflow strip, live KPI tiles (total, allowed, denied, proofs valid, failed/corrupt), a **Recent activity** feed of the five most recent decisions (each with outcome/proof/payment chips, a deterministic explanation, a relative timestamp, an honest "Updated Xs ago", and a link to detail), and a "How a purchase is proven" explainer. |
| `/decisions` | **Decisions** | The real ledger table: Time, Agent, Vendor, Amount, Outcome, Proof, Payment, and a deterministic **Explanation** (fired rules kept visible beneath). Filters by outcome, status, agent, and fired rule; cursor "Load more" pagination; corrupt rows flagged. |
| `/decisions/:id` | **Decision detail** | The auditor view, built around the **execution timeline** (below) with request, outcome + fired rules, provenance flow, trusted facts, proof id + independent verification, policy digest, and the sandbox receipt beneath it. |
| `/policy` | **Policy** | The caps and clearances the kernel enforces, **derived** from the authoritative facts on recorded decisions, plus the **Policy digest** and a read-only **Policy simulator** (below). |

Navigation is deliberately only **Overview / Decisions / Policy**. The former
standalone "Audit" route was folded into the decision detail (same trace, one
place); "Cards & Limits" was renamed "Policy".

### The execution timeline

The decision detail is organized as a six-stage timeline that keeps every claim
*separable*, each shown honestly:

**Agent request → Trusted facts loaded → Policy evaluated → Decision recorded →
Proof validated → Payment executed / blocked / failed**

A **policy denial** (blocked) is never conflated with a **payment failure**
(failed) or a **proof mismatch** (tampered) or a **corrupt** record; an
unexecuted allow reads *skipped*, not settled. Proof state reads **"Proof valid"**
when it recomputes and matches, ✕ when tampered. The former four-part trust
ladder (*decision allowed · audit persisted · proof verified · payment executed*)
is expressed as stages of this one timeline rather than a separate strip.

### Policy simulator (read-only)

The Policy page carries a read-only simulator: it calls the bridge's
`GET /simulate` to run a hypothetical purchase through the **real** kernel and
shows ALLOWED/DENIED, a deterministic explanation, the fired rules (with raw
ids), a facts-derived policy-checks checklist, the policy digest, and a
"Simulation only — no payment executed" label. Seeded example scenarios prefill
the form (they never auto-run). It is side-effect free — it records nothing and
executes nothing. **Policy editing is intentionally out of scope** (it needs
versioning, approvals, rollback, and its own audit trail first).

## States (all real)

`loading` (skeletons) · `empty` ("no decisions yet — trigger a `pay_vendor`
call") · `bridge unavailable` (honest error card with the exact start command +
Retry; header shows "Bridge offline") · `malformed response` · `404` (decision
not found) · `corrupt record` (flagged, never hidden) · `tampered proof`
(verification shows ✕). Light + dark themes (toggle initializes from OS
preference, forces either, persists to `localStorage`). Accessibility: skip-link,
`:focus-visible` rings, labeled nav icons, AA-contrast status chips, and status
never conveyed by color alone.

## Run locally

Build the workspace first:

```sh
pnpm -r build
```

### Demo (real allow / deny / failure — no Claude Code needed)

Pick one absolute, shared DB path so the demo, the bridge, and the dashboard all
read the same ledger:

```sh
export RAMP_DB_PATH="$PWD/packages/ledger/ramp.db"

# 1) Drive the real MCP stdio server: an allow that settles, a deny,
#    and a sandbox executor failure.
RAMP_DB_PATH=$RAMP_DB_PATH node apps/payments-mcp/scripts/demo.mjs
```

Then, in two separate terminals **with the same `RAMP_DB_PATH`**:

```sh
# 2) Start the read-only ledger bridge (default port 8787).
RAMP_DB_PATH=$RAMP_DB_PATH pnpm --filter @ramp/ledger bridge

# 3) Start the dashboard.
pnpm --filter @ramp/dashboard dev
```

Open <http://localhost:5173>.

### Alternative: drive it from Claude Code

Register the MCP server, then ask the agent to pay a compliant vs. a
non-compliant vendor:

```sh
claude mcp add payments -- node /ABSOLUTE/PATH/TO/ramp/apps/payments-mcp/dist/server.js
```

Set `RAMP_DB_PATH` in that server's env so it writes the same ledger the bridge
reads.

## Configuration

| Var | Applies to | Default | Notes |
|---|---|---|---|
| `VITE_BRIDGE_URL` | dashboard | `http://localhost:8787` | base URL of the read-only bridge |
| `PORT` | bridge | `8787` | bridge listen port |
| `RAMP_DB_PATH` | bridge, demo, MCP | — | absolute path to the shared ledger DB; must match across processes |
| `RAMP_BRIDGE_ORIGIN` | bridge | `http://localhost:5173` | CORS is pinned to this **one** origin — it must equal the dashboard origin |

## Troubleshooting

**"Ledger bridge unavailable"** — the dashboard couldn't reach the bridge. In order:
1. Is the bridge running? Start it: `pnpm --filter @ramp/ledger bridge` (build first with `pnpm -r build`). It prints `listening on :8787`.
2. Does `VITE_BRIDGE_URL` (default `http://localhost:8787`) match the bridge's `PORT`?
3. Does `RAMP_BRIDGE_ORIGIN` (default `http://localhost:5173`) equal the dashboard's dev origin? A mismatch fails CORS.

**Bridge is up but shows no / stale decisions** — the server and the bridge must read the **same** file. The bridge defaults to `packages/ledger/ramp.db` (relative to its package dir); point the MCP server at that same absolute path via `RAMP_DB_PATH`. A `pnpm --filter @ramp/ledger db:reset` reseeds it. An older DB missing a newer table is healed automatically on the next open (the schema is applied idempotently), so you should never see a "no such table" error.

## Proof & provenance semantics

- **Independent verification.** The proof is recomputed on **every read** and
  never trusted from the stored bytes. It is four-valued: `ok` (verified) /
  `mismatch` (tampered) / `corrupt` (malformed) / `absent` (no proof stored).
- **Provenance is trusted-derived**, assembled from the authoritative facts and
  the recorded decision — **not** agent-supplied narration. It renders as a
  readable linear flow, and degrades honestly (deriving from the decision) when a
  row has no stored provenance graph.

## Sandbox limitations (be explicit)

- **No real money moves.** The executor is a deterministic sandbox and receipts
  are simulated.
- `RAMP_FAIL_VENDORS` forces a sandbox failure so the demo can show a failed
  receipt.
- Attestation is honest — it is never reported as "verified" at the hook.

## Known limitations

- **KPIs count the latest 200 decisions** (the Overview notes this honestly when
  more exist).
- The **Claude Code hook path records a decision *without* executing**, so an
  allowed hook-row shows "not executed".
- Under Claude Code, an allowed spend can produce **two audit rows** — the hook's
  check and the tool's execution — by design.
- **Policy config is derived** from observed decision facts (there is no separate
  policy-config endpoint), so `/policy` is empty until decisions with facts exist.
- **Policy editing is intentionally out of scope** — the simulator only previews;
  it cannot change policy. Historical policy **versioning** (version numbers,
  change history) is deferred future work; the console surfaces a policy *digest*,
  not a version.
- The build uses a **relative asset base** (`base: './'`), so in-app navigation
  via links works everywhere, but a hard browser reload of a deep URL
  (`/decisions/:id`) on a static file server needs SPA fallback / an absolute
  base. The `vite dev` server (the demo path) handles deep loads directly.

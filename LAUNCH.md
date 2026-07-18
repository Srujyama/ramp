# LAUNCH — run it, then demo it

**Warrant** — make every AI-agent payment decision *provable*, not trusted.
One line: **"Everyone else scopes the card. We prove the decision."** The pitch itself
lives in [`PITCH.md`](./PITCH.md); this file is the operator's guide — how to get the whole
system running, walk the live demo, and drive a *real* gated payment from a coding agent.

> **Sandbox only. No real money moves.** No payment provider is configured; the executor
> mints fake receipts. Everything below is safe to run end to end.

---

## 0. TL;DR — one paste to a running demo

```bash
# from the repo root, Node 24 + pnpm
pnpm install
pnpm db:reset && pnpm build && pnpm test     # → 575 tests, 0 fail (1 wasm-parity skip is expected)
pnpm demo                                     # drive every PITCH beat through the REAL hook
pnpm proof                                    # independently re-verify the sealed bundles

# the live dashboard needs THREE processes — one per terminal:
pnpm bridge          # read-only audit bridge   → http://localhost:8787
pnpm control-plane   # demo control plane        → http://localhost:8788
pnpm dev             # dashboard (Vite)          → http://localhost:5173
pnpm notary-server        # standalone HTTP notary on :8790 (NOTARY_PORT to override)
```

Open <http://localhost:5173/app>, then jump to [§4 the demo script](#4-the-demo-script).

---

## 1. Prerequisites

| Need | Why |
| --- | --- |
| **Node 24+** | `node:sqlite` and the built-in `node --test` runner are used directly (no better-sqlite3, no jest). |
| **pnpm** | The monorepo is a pnpm workspace. `corepack enable` gives you it. |
| Rust + `wasm-pack` *(optional)* | Only to compile the kernel to WASM and run the **4-way parity** locally. Everything else runs without it; the one skipped test is this parity check. |

No API keys, no database server, no cloud anything. The ledger is a local SQLite file.

---

## 2. Install & verify

```bash
pnpm install
pnpm db:reset      # rebuild the ledger from sql/schema.sql + sql/seed.sql
pnpm build         # tsc across every workspace
pnpm test          # → tests 575 · pass 575 · fail 0
```

Then prove the product actually enforces — a green `pnpm test` with a broken hook is a broken
product (that is exactly how the $400 fail-open once survived):

```bash
pnpm demo    # spawns .claude/hooks/evaluate.mjs as a REAL subprocess for every PITCH beat
             # and asserts the process EXIT CODES, not just that functions return
pnpm proof   # re-derives every recorded decision from its recorded facts and walks the hash chain
```

`pnpm demo` ends with **"All beats behaved as pitched."** and `pnpm proof` with **"Every recorded
decision follows from its recorded facts …"**. For the adversary's view: `pnpm redteam` fires 18
attacks at the real hook and must report **18/18 blocked**.

---

## 3. The mental model — three planes, one that decides

The demo is interactive *without* letting the audit console ever write a decision. Keep these
three planes straight and everything else follows:

```
            ┌──────────────────────────────────────────────────────────────┐
            │  1. THE GATE — the only thing that decides                    │
            │     .claude/hooks/evaluate.mjs  (PreToolUse hook)             │
            │     • non-bypassable: runs BEFORE the payments MCP tool       │
            │     • fail-CLOSED: any error → deny, exit 2                    │
            │     • facts come from the ledger/registry, NEVER model text   │
            │     • deterministic Datalog kernel (@ramp/gate)               │
            └───────────────┬──────────────────────────────────────────────┘
                            │ writes (append-only, hash-chained, 2 proofs each)
                            ▼
                 ┌────────────────────────┐
                 │  the ledger (SQLite)   │  ← single source of truth
                 └───────┬────────────────┘
                  reads  │  (GET only)          reads+admin-writes (INPUT tables only)
          ┌──────────────┘                 └──────────────────────────┐
          ▼                                                            ▼
┌───────────────────────────┐                    ┌──────────────────────────────────────┐
│ 2. AUDIT BRIDGE  :8787     │                    │ 3. DEMO CONTROL PLANE  :8788           │
│    @ramp/ledger bridge     │                    │    @ramp/control-plane                 │
│  • strictly READ-ONLY —    │                    │  • separate process; if it dies the    │
│    no mutation route ever  │                    │    gate is unaffected                  │
│  • the dashboard reads it  │                    │  • pricing (off the decision path)     │
│  • SSE live tail (a GET)   │                    │  • POST /transaction → drives the REAL │
└───────────────────────────┘                    │    gate (never decides itself)         │
                                                  │  • POST /agents, PATCH /policy → writes │
                                                  │    INPUT tables ONLY, never a decision │
                                                  └──────────────────────────────────────┘
```

**Why the split matters:** the security boundary is that the console can only *read*. Interactivity
(simulate a payment, create an agent, retune a dial) lives in a **separate demo-only process** that
either drives the *real* gate or edits the *inputs* a future decision is computed from. Neither can
author a decision or bypass the hook.

---

## 4. The demo script

With the bridge, control plane, and dashboard running (§0), open <http://localhost:5173/app> and
walk these tabs. Everything shown is real — re-derivable, not mocked.

1. **Overview** — money stopped, decision mix, chain integrity at a glance.
2. **Activity** → click any decision → **Decision detail.** This page **re-runs the real kernel in
   your browser** over the recorded facts and shows it reaches the same verdict — provability you can
   watch, not take on faith. It also shows both proofs (integrity *and* soundness) and the provenance
   graph.
3. **Simulate** — trigger a spend without an MCP terminal. Pick a preset (valid / over-threshold /
   unverified vendor / over-cap / no-attestation) and **Run transaction.** This is a **real gated
   decision** — allow/deny/escalate falls out of policy, it isn't faked — recorded, hash-chained, and
   it **streams live into Activity** while you watch.
4. **Admin** — the interactive payoff:
   - *Create an agent card* (id, name, cleared categories). An unregistered agent is refused facts by
     the gate, so this is what makes a new agent spendable.
   - *Retune a policy dial* (per-txn cap, daily limit, escalation threshold, velocity). Then go back to
     **Simulate**, run the same request, and **watch the gate decide differently** — because the kernel
     reads these inputs. The edit changes the *next* decision; it can never rewrite a sealed one.
5. **Policy** — the live dials + a read-only what-if simulator.
6. **Pricing** — current model $/token for cost context. **Reference only** (see caveats) — never a
   fact, never gates anything.

---

## 5. Drive it from a real coding agent (MCP)

The dashboard's Simulate tab is convenient, but the honest headline is that a *coding agent* — Claude
Code, Cursor, Codex — can request a payment and be gated for real. The agent calls one MCP tool,
**`mcp__payments__pay_vendor`**; the **hook decides before the tool is allowed to run.**

```bash
pnpm build                     # so apps/payments-mcp/dist/server.js exists
# register the server with your client (absolute path to this checkout):
claude mcp add payments -- node /ABSOLUTE/PATH/TO/ramp/apps/payments-mcp/dist/server.js
```

Point the MCP server, the bridge, and the dashboard at **one** ledger so a tool-driven payment shows
up live: set `RAMP_DB_PATH` (in the MCP config's `env`) to the same absolute path the bridge uses.
Full per-client setup: [`apps/payments-mcp/mcp-clients/`](./apps/payments-mcp/mcp-clients/)
(`claude-code.md`, `cursor.md`, `codex.md`).

Then, in the agent, a prompt like:

> Pay acme_corp 340 USD for office supplies, invoice inv_2026_07_0043, on behalf of agent_47.

The hook evaluates it, the decision is sealed, and it appears on the dashboard the same instant. Drop
the attestation or push the amount over the cap and it denies — for a real, recorded reason.

> **The gate is separate from, and stronger than, the MCP tool.** The tool (`@ramp/payments-mcp`) is
> a *self-enforcing* honest stub — it drives the same lifecycle itself, so it is safe even with **no
> hook present**. The hook is the second, non-bypassable gate over the same kernel. See
> [`hook/README.md`](./hook/README.md) for the fail-closed design.

### 5a. Attest from an independent process, not the agent itself

Don't have the agent call `scripts/notary.mjs` in-process to mint its own attestation — that makes
the payer notarize its own invoice on screen, which is the exact self-attestation failure pillar 4
exists to rule out (see `packages/attestation/README.md`). Instead run the demo notary as its own
process, on its own port, and have the agent fetch from it like it would fetch from any other
external service:

```bash
pnpm notary-server        # standalone HTTP notary on :8790 (NOTARY_PORT to override)
```

```
GET /health
GET /attestation/hero
GET /attestation?amount=340&category=office_supplies[&vendor-domain=...&invoice-ref=...&invoice-text=...]
```

Then prompt the agent with something like *"fetch an attestation from
`http://localhost:8790/attestation/hero`, then pay acme_corp using `pay_vendor` with whatever it
returns"* — the agent never signs anything itself, it only consumes a signature from a process it
doesn't control. Same underlying `mintAttestation` logic as `scripts/notary.mjs`; the only thing
that changed is the process boundary, which is what makes the demo topology match the real claim
(an independent notary witnesses the invoice) instead of quietly contradicting it. Still not real
TLSNotary MPC — see the attestation README's "Scope" section before overclaiming this on stage.

---

## 6. Honest caveats — read these; they are the whole point

This project's thesis is *provability*, so it is precise about what is proven and what is only shown.

- **A simulated transaction is a REAL gated decision, not a fabricated row.** "Simulate" means "run
  a real request through the real gate," not "insert a fake outcome." You cannot hand-author a verdict
  anywhere in this system.
- **"Edit validation rules" means the dials and clearances — not the kernel logic.** The Admin tab
  tunes *inputs*: caps, limits, thresholds, velocity, which categories an agent may spend in. The
  decision *logic* (`policy.dl` and its TypeScript / Rust-WASM / standalone mirrors) is frozen,
  versioned, and kept in **4-way parity** by CI. You change what the gate measures against, never how
  it decides.
- **Token usage / cost shown for an agent run is an ESTIMATE.** An MCP tool call does not carry the
  model's token accounting, so per-payment "cost" is derived from pricing × an assumed usage, and is
  labeled as such. It is context, never an input to any decision.
- **Model pricing is reference-only and lives off the decision path.** It is fetched out-of-band by
  the demo control plane (with a static fallback) purely so the UI can show $/token. The gate and
  kernel never read it and stay network-free and deterministic.
- **Sandbox — no real money moves.** The executor mints fake receipts; no payment provider is wired.

---

## 7. Command reference (the essentials)

| Command | What it does |
| --- | --- |
| `pnpm db:reset` | Rebuild the ledger from `schema.sql` + `seed.sql`. |
| `pnpm setup` | `db:reset` + `db:history` — seed a full synthetic decision history through the real lifecycle. |
| `pnpm build` / `pnpm test` | Build / run every workspace's suite (575 tests). |
| `pnpm demo` | Drive every PITCH beat through the **real hook**; assert exit codes. |
| `pnpm proof` | Independently re-verify the sealed bundles + walk the chain. |
| `pnpm redteam` | Fire 18 attacks at the real hook; non-zero on any breach. |
| `pnpm bridge` | Read-only audit bridge (**:8787**) the dashboard reads. |
| `pnpm control-plane` | Demo-only control plane (**:8788**) — pricing, real gated transactions, input-table admin. |
| `pnpm dev` | Dashboard (Vite dev server, **:5173**). |
| `pnpm mcp` | Start the payments MCP server over stdio. |
| `pnpm notary-server` | Standalone attestation notary over HTTP (**:8790**) — for demoing from an agent without the agent minting its own attestation. |

The full script catalogue (explain, simulate, policy-diff, receipt, notary, approve, head, stats) is
in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

## 8. Troubleshooting

- **The dashboard is stale / Simulate returns nothing after `pnpm db:reset`.** `db:reset` recreates
  the DB file (new inode), but a bridge / control-plane started earlier still holds the *old* file.
  **Restart `pnpm bridge` and `pnpm control-plane` after any `db:reset`.**
- **"Could not reach the demo control plane."** The dashboard's Simulate / Admin / Pricing tabs need
  `pnpm control-plane` running on :8788. (Activity, Decisions, Overview need `pnpm bridge` on :8787.)
- **One test skipped.** The `wasm kernel — 4-way parity` test skips without Rust + `wasm-pack`
  installed. That is expected locally; CI runs it for real.
- **Ports busy.** Override with `PORT` (the bridge), `CONTROL_PLANE_PORT` (the control plane), `NOTARY_PORT`
  (the notary server), and Vite's `--port` (the dashboard).
- **A rehearsed "allow" beat starts denying.** The hero beat only allows because
  `1140 (seed) + 340 ≤ 1500`. Every prior demo/test run against the same DB adds to that agent's
  daily total, so repeated rehearsals — or anyone else's MCP/agent testing against the same shared
  `RAMP_DB_PATH` — eat the headroom until the same request denies. `pnpm db:reset` (then restart the
  bridge and control plane, per above) right before you actually demo, not hours before.

---

## 9. Go deeper

| Doc | What |
| --- | --- |
| [`PITCH.md`](./PITCH.md) | The canonical pitch — the single source of truth for the story. |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributor guide, full script list, and the frozen invariants. |
| [`hook/README.md`](./hook/README.md) | The fail-closed gate: why it is non-bypassable and how it fails closed. |
| [`apps/payments-mcp/README.md`](./apps/payments-mcp/README.md) | The agent-facing MCP server + per-client setup. |
| [`README.md`](./README.md) | Repository overview and the workspace map. |

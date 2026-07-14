# Provable Agent Spend

**A deterministic Datalog policy gate for agent payments.**

When an AI agent tries to spend money, you should not have to trust its explanation. This
project puts a small, mechanical **policy kernel** between the agent and the payment: every
spend request is reduced to a closed set of **facts pulled from authoritative sources**
(never the model's narration), and those facts are ground through a Datalog program that
returns `allow` / `deny` the same way every time. Same facts → same answer, and the facts
are true.

> See the full pitch and demo script in **[`hackathon-plan.html`](./hackathon-plan.html)**.

## Why it's trustworthy

- **The model never decides.** The gate reads the amount, vendor, category, spend-so-far,
  caps, and clearances from the **ledger DB + vendor registry + structured tool args** — the
  agent's free-text reasoning is used only as *keys* to look things up, never as facts.
- **The kernel is deterministic and pure.** `evaluate(facts) → decision` has no clock, no
  I/O, no randomness. Identical facts always yield an identical decision. `deny` dominates:
  any single deny rule denies the spend.
- **Enforcement is fail-closed.** A `PreToolUse` command hook intercepts the payment tool
  *before* it runs; any bad input, unreachable DB, or kernel error emits a **deny** and exits
  non-zero. There is no "fail open" path.
- **It's auditable.** Every decision carries the exact `RuleId`s that fired and a
  human-readable reason per rule — the same rule ids used by both kernel implementations, the
  dashboard, and the audit view.

## Architecture

```
  agent calls  mcp__payments__pay_vendor
        │
        ▼
  ┌──────────────────────────────┐   raw SpendRequest (UNTRUSTED transport)
  │  .claude/hooks/evaluate.mjs  │   — used only as lookup keys
  │      (fail-closed hook)      │
  └──────────────┬───────────────┘
                 │  keys: agent, vendor, category, amount
                 ▼
  ┌──────────────────────────────┐   AUTHORITATIVE facts:
  │   @ramp/ledger  (SQLite)     │   vendor_verified, daily_total_so_far,
  │   + vendor registry          │   caps, approved + cleared categories
  └──────────────┬───────────────┘
                 │  Facts  (the frozen contract, @ramp/shared)
                 ▼
  ┌──────────────────────────────┐   policy.dl (Souffle) ⇄ TS reference kernel
  │   @ramp/gate  PolicyKernel   │   deny dominates; deterministic + pure
  └──────────────┬───────────────┘
                 │  Decision { decision, reasons, firedRules }
                 ▼
     hook returns allow / deny   ──►  @ramp/dashboard visualizes decisions & audit
```

The seam between "facts" and "allow/deny" is a single interface, `PolicyKernel`, with **two
implementations behind it**: a TypeScript **reference kernel** (the golden oracle, always
available, zero deps) and an optional **WASM kernel** compiled from `policy.dl`. Callers are
implementation-agnostic; a parity test cross-checks the two.

## Workspace map

| Workspace             | Path                   | Depends on        | What it is                                                            |
| --------------------- | ---------------------- | ----------------- | -------------------------------------------------------------------- |
| **`@ramp/shared`**    | `packages/shared/`     | —                 | The **frozen contract**: `Facts`, `Decision`, `RuleId`, `PolicyKernel`, `SpendRequest`, fact translation. Zero runtime deps; imported by everyone. |
| **`@ramp/gate`**      | `packages/gate/`       | `@ramp/shared`    | The **policy kernel** (hero). `policy.dl` (Souffle) is the source of truth; the TS reference kernel mirrors it line-for-line; optional WASM build. |
| **`@ramp/ledger`**    | `packages/ledger/`     | `@ramp/shared`    | The **authoritative fact source** (SQLite) + vendor registry. Pure DB reads — never model narration. |
| **`@ramp/payments-mcp`** | `apps/payments-mcp/`| `@ramp/shared`    | Stub MCP server exposing `mcp__payments__pay_vendor`. An honest non-enforcing stub — enforcement lives in the hook. |
| **`@ramp/dashboard`** | `apps/dashboard/`      | `@ramp/shared`    | Vite + React shell to view decisions and "prove this to an auditor". |
| The hook              | `.claude/`             | gate + ledger + shared | The fail-closed `PreToolUse` enforcement point — the ONLY place policy is enforced. |

**Ownership:** @Srujyama owns the gate + shared contract + repo wiring; @neilporw owns the
ledger fact source + payments MCP stub; @JonKach owns the dashboard shell. See
[`.github/CODEOWNERS`](./.github/CODEOWNERS).

## Quickstart

```bash
# Prereqs: Node >= 24 (see .nvmrc) and pnpm 11.13.0 (corepack enable).
nvm use
corepack enable

pnpm install         # install the whole workspace
pnpm db:reset        # build the demo ledger from schema.sql + seed.sql
pnpm build           # tsc build every package
pnpm test            # run every workspace's node:test suite

pnpm dev             # start the dashboard shell (Vite)
pnpm mcp             # (separately) run the stub payments MCP server
```

The demo scenario is seeded: agent `agent_47`, verified vendor `acme_corp`, approved
category `office_supplies`, per-transaction cap `500`, daily limit `1500`, prior spend today
`1140`. The hero happy path — a `340` request — **allows** (`1140 + 340 = 1480 <= 1500`).
Deny beats are seeded off the same DB: unverified vendor (`sketchy_llc`), unapproved category
(`crypto`), and approved-but-uncleared (`travel`, which `agent_47` isn't cleared for).

> **Seed note:** the prior total is `1140`, not `1200` — deliberately, so the happy path
> allows. Don't "fix" it. Details in `packages/ledger/sql/seed.sql` and `CONTRIBUTING.md`.

## Optional: the WASM kernel

The TS reference kernel is always the default, so nothing below is required:

```bash
pnpm build:wasm      # no-op unless `souffle` AND `wasm-pack` are on PATH
RAMP_KERNEL=wasm pnpm --filter @ramp/gate test:parity
```

## Collaborators

- **@Srujyama** (owner) — the gate + shared contract + repo wiring
- **@neilporw** — the ledger/registry fact source + payments MCP stub
- **@JonKach** — the dashboard shell

## Contributing

Read **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** — it covers the toolchain, the PR flow,
workspace ownership, and (importantly) the parts of the contract that are **frozen** and must
not drift.

# Contributing to Provable Agent Spend

Thanks for building on the gate. This repo is a small pnpm monorepo with a **frozen
contract** at its core — read the guardrails before you push.

## Prerequisites

- **Node.js `>= 24`** — the repo pins `24` in [`.nvmrc`](./.nvmrc). Run `nvm use`.
- **pnpm `11.13.0`** — declared as `packageManager`. Enable it with `corepack enable`,
  or `npm i -g pnpm@11.13.0`.
- `engine-strict` is on, so a mismatched Node/pnpm will refuse to install. That's on
  purpose — it keeps everyone on the same toolchain.

## Clone & install

```bash
git clone <this-repo-url> ramp
cd ramp
nvm use                 # picks Node 24 from .nvmrc
corepack enable         # provides pnpm 11.13.0
pnpm install            # installs the whole workspace
```

## Everyday commands (run from the repo root)

| Command                 | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `pnpm build`            | `tsc` build every workspace (`pnpm -r build`).                      |
| `pnpm typecheck`        | Type-check every workspace, no emit.                               |
| `pnpm test`             | Run every workspace's `node --test` suite.                          |
| `pnpm lint`             | Type-level lint (`tsc --noEmit`) across the graph.                  |
| `pnpm db:reset`         | Rebuild the ledger SQLite DB from `schema.sql` + `seed.sql`.        |
| `pnpm dev`              | Start the dashboard shell (Vite dev server).                       |
| `pnpm mcp`              | Start the stub payments MCP server over stdio.                     |
| `pnpm build:wasm`       | OPTIONAL — compile the Souffle kernel to WASM (no-op without tools).|

First-time local setup usually is: `pnpm install` → `pnpm db:reset` → `pnpm build`.

## Workspace ownership

Each package has an owner (enforced by [`.github/CODEOWNERS`](./.github/CODEOWNERS)).
Keep your changes inside the workspace you own; touching a neighbor's files means their
review is required.

| Workspace             | Path                   | Owner       | Role                                    |
| --------------------- | ---------------------- | ----------- | --------------------------------------- |
| `@ramp/shared`        | `packages/shared/`     | @Srujyama   | The frozen contract (types everyone imports). |
| `@ramp/gate`          | `packages/gate/`       | @Srujyama   | The policy kernel + `policy.dl` (the hero). |
| `@ramp/ledger`        | `packages/ledger/`     | @neilporw   | Authoritative fact source (SQLite).     |
| `@ramp/payments-mcp`  | `apps/payments-mcp/`   | @neilporw   | Stub MCP server that emits spend requests. |
| `@ramp/dashboard`     | `apps/dashboard/`      | @JonKach    | Vite + React shell.                     |
| The hook              | `.claude/`             | @Srujyama   | The fail-closed PreToolUse enforcement point. |
| Repo infra            | `.github/`, root config| @Srujyama   | CI, CODEOWNERS, root scaffolding.       |

## The contract is frozen — do not drift it

The whole security argument is "same facts → same answer, and the facts are true." That
only holds if the shared contract stays stable. **Do not change these without an explicit,
coordinated decision:**

- **`Facts` field names** (`packages/shared/src/facts.ts`) map 1:1 onto the `policy.dl`
  input relations. Adding a fact means editing BOTH `facts.ts` AND `policy.dl`, plus the
  ledger fact-source and the reference kernel.
- **`RuleId` strings** (`packages/shared/src/decision.ts`) are shared by the reference
  kernel, the (optional) wasm kernel, the dashboard badge, and the audit trail.
- **`Decision` shape** is exactly `{ decision, reasons, firedRules }`.
- **No security-critical fact may come from the model's free-text narration** — only the
  ledger DB, the vendor registry, and the structured tool args.

Two things that look like bugs but are not — read before "fixing":

- **The seed prior total is `1140`, not `1200`.** The hero happy path (req_9f, 340) must
  ALLOW: `1140 + 340 = 1480 <= 1500`. The plan's `1200 + 340 > 1500` string describes the
  over-limit deny beat, not the happy path. See the comments in `seed.sql`.
- **The wasm kernel is OPTIONAL.** `build:wasm` is a no-op when `souffle`/`wasm-pack` are
  absent, and the TS reference kernel is always the default. CI stays green without them.

## Optional: the Souffle → WASM kernel

The gate ships a TS reference kernel (the golden oracle) that is always available. A
second, WASM-backed kernel can be compiled from `packages/gate/policy.dl` for those who
have the toolchain:

```bash
# needs `souffle` and `wasm-pack` on PATH; otherwise this is a safe no-op
pnpm build:wasm
RAMP_KERNEL=wasm pnpm --filter @ramp/gate test:parity   # cross-check vs the oracle
```

Without those tools installed, everything still builds, tests, and runs on the reference
kernel — the `wasm-kernel` CI job is `continue-on-error` and skips itself.

## Pull request flow

1. Branch off `main`: `git checkout -b <area>/<short-description>`.
2. Make your change **inside the workspace you own**. Add/adjust `node:test` tests.
3. Before pushing, run the gate locally:
   ```bash
   pnpm typecheck && pnpm build && pnpm test
   ```
4. Push and open a PR. The template prompts you to tick the workspace(s) touched and
   confirm the contract-safety checklist; CODEOWNERS auto-requests the right reviewer.
5. CI runs typecheck · build · test on Node 24. Green + owner approval → merge.

Keep money as **integer whole units** everywhere (no floats), use **snake_case** for
fact/relation identifiers, and remember relative TS imports need the explicit `.js`
extension (NodeNext).

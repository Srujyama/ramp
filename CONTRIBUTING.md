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
| `pnpm demo`             | **Drive every PITCH.md beat through the real hook; assert exit codes.** |
| `pnpm proof`            | **Independently re-verify the provenance bundles the gate sealed.** |
| `pnpm approve`          | **The HUMAN channel** — list held payments; approve/reject one. Never an MCP tool. |
| `pnpm notary`           | Mint a demo attestation (`--spoof` / `--stale` for the deny beats). |
| `pnpm dev`              | Start the dashboard shell (Vite dev server).                       |
| `pnpm mcp`              | Start the stub payments MCP server over stdio.                     |
| `pnpm build:wasm`       | OPTIONAL — compile the Souffle kernel to WASM (no-op without tools).|

First-time local setup usually is: `pnpm install` → `pnpm db:reset` → `pnpm build` → `pnpm demo`.

**`pnpm test` is not enough.** It proves the *kernel* works. `pnpm demo` spawns
`hook/evaluate.mjs` as a real subprocess — exactly how Claude Code invokes it — and asserts the
**exit code**, which is the actual contract with Claude Code. A green kernel behind a broken hook is
a broken product; that is precisely how a fail-open that allowed a $400 over-limit payment survived
a fully green test suite. Both `pnpm demo` and `pnpm proof` run in CI.

## Workspace ownership

Each package has an owner (enforced by [`.github/CODEOWNERS`](./.github/CODEOWNERS)).
Keep your changes inside the workspace you own; touching a neighbor's files means their
review is required.

| Workspace             | Path                   | Owner       | Role                                    |
| --------------------- | ---------------------- | ----------- | --------------------------------------- |
| `@ramp/shared`        | `packages/shared/`     | @Srujyama   | The frozen contract (types everyone imports). |
| `@ramp/gate`          | `packages/gate/`       | @Srujyama   | The policy kernel + `policy.dl` (the hero). |
| `@ramp/quarantine`    | `packages/quarantine/` | @Srujyama   | Pillar 3: CaMeL quarantine + declassifiers. |
| `@ramp/attestation`   | `packages/attestation/`| @Srujyama   | Pillar 4: Ed25519 notary attestation. |
| `@ramp/provenance`    | `packages/provenance/` | @Srujyama   | Pillar 2: decision bundles + the auditor's verifier. |
| `@ramp/ledger`        | `packages/ledger/`     | @neilporw   | Authoritative fact source (SQLite).     |
| `@ramp/payments-mcp`  | `apps/payments-mcp/`   | @neilporw   | Stub MCP server that emits spend requests. |
| `@ramp/dashboard`     | `apps/dashboard/`      | @JonKach    | Vite + React shell.                     |
| The hook              | `.claude/`             | @Srujyama   | The fail-closed PreToolUse enforcement point. |
| Repo infra            | `.github/`, root config| @Srujyama   | CI, CODEOWNERS, root scaffolding.       |

Collaborators: **@Srujyama** (owner), **@neilporw**, **@JonKach**, **@tomasciar**. @tomasciar has no
workspace claimed yet — pick one and add a `CODEOWNERS` line rather than leaving it to the fallback.

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

Things that look like bugs but are not — read before "fixing":

- **The seed prior total is `1140`, not `1200`.** The hero happy path (req_9f, 340) must
  ALLOW: `1140 + 340 = 1480 <= 1500`. The plan's `1200 + 340 > 1500` string describes the
  over-limit deny beat, not the happy path. See the comments in `seed.sql`.
- **The wasm kernel is OPTIONAL.** `build:wasm` is a no-op when `souffle`/`wasm-pack` are
  absent, and the TS reference kernel is always the default. CI stays green without them.
- **`deny/malformed_facts` exists in the TS/Rust kernels but NOT in `policy.dl`.** This asymmetry is
  deliberate and documented in all three files. Soufflé's `number` is an INTEGER type, so NaN,
  Infinity and floats cannot be written in `policy.dl` at all. TypeScript's `number` is IEEE-754 and
  admits them — and NaN is poison, because every comparison against it is false. With `amount: NaN`,
  `NaN > per_txn_cap` was false AND `daily_total + NaN > daily_limit` was false, so neither numeric
  deny fired and the kernel returned `all_conditions_met: amount NaN within cap 500`. **A NaN was
  payable.** The mirrors must enforce at runtime what Soufflé enforces in its type system. Do not
  "restore parity" by deleting it.
- **`DEFAULT_DB_PATH` is an absolute path anchored to `import.meta.url`, and the hook opens the
  ledger with `openLedgerStrict`.** Both are fail-open fixes, not style. A bare relative `"ramp.db"`
  resolves against each caller's cwd, so `pnpm db:reset` (cwd `packages/ledger`) and the hook (cwd =
  project root) read **different files**; `openLedger`'s auto-provisioning then turned the wrong path
  into a pristine ledger reporting **zero spend today**, and the gate allowed a $400 payment it had
  to deny. Never make the path cwd-relative; never auto-provision on the enforcement path.
- **`@ramp/quarantine`'s `stableEncode` deliberately avoids `JSON.stringify`.** It throws on BigInt
  and circular refs, which made `quarantine()` — the wrapper you call at the trust boundary on bytes
  you did not author — throw on attacker-chosen input. Boundary wrappers must be total.
- **`detect.ts` gates nothing, on purpose.** It is telemetry. If every heuristic returned `false` for
  a real attack the guarantees would be unchanged, because the defence is structural. Do not wire it
  into a decision.

- **`escalate` is a THIRD outcome, and two-valued logic silently mis-handles it.** When it landed,
  every `if (decision === "deny") return;` in the codebase started letting escalations *fall through*
  — `purchase.ts` would have EXECUTED every payment policy said a human must approve, with no error
  anywhere. Use `permitsPayment(d)` (allow only, stated positively), never `!isDenied(d)`. Ternaries
  on outcome are the same trap: one recorded an escalation as `"denied"`, and the dashboard chip
  showed a HELD payment as refused.
- **`migrate.ts` can delete the audit trail if you edit it carelessly.** SQLite can't ALTER a CHECK,
  so widening one rebuilds `decisions` — and `decision_proofs` references it `ON DELETE CASCADE`.
  Without `PRAGMA foreign_keys = OFF` before the swap, the DROP erases every proof. There is a
  mutation-tested guard (`THE FOOTGUN: migrating does NOT cascade-delete proofs`); removing the
  pragma makes 8 tests fail. Keep it that way.

- **NO MCP tool may reach `resolveEscalation`.** If the agent can approve its own escalation, the
  feature is theatre that manufactures evidence of a control that doesn't exist. The agent's tools
  are read-only by construction; approving is `pnpm approve`, a human channel. There's an
  architecture test (`THE CONTROL: no MCP source imports or calls resolveEscalation`) that fails CI
  if you add one — it strips comments first, so the file can explain the rule without tripping it.
  Mutation-tested.
- **An approval binds to `content_digest`.** Never accept an approval verdict from a caller, and
  never look one up by agent or vendor — only by decision id, with the digest checked. Otherwise a
  $1 approval can be presented against a $50,000 payment.

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
3. Before pushing, run the gate locally — including the beats, not just the tests:
   ```bash
   pnpm typecheck && pnpm build && pnpm test
   pnpm db:reset && pnpm demo && pnpm proof --summary
   ```
4. Push and open a PR. The template prompts you to tick the workspace(s) touched and
   confirm the contract-safety checklist; CODEOWNERS auto-requests the right reviewer.
5. CI runs typecheck · build · test on Node 24. Green + owner approval → merge.

Keep money as **integer whole units** everywhere (no floats), use **snake_case** for
fact/relation identifiers, and remember relative TS imports need the explicit `.js`
extension (NodeNext).

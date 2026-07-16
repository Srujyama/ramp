# Provable Agent Spend

**A deterministic Datalog policy gate for agent payments.**

When an AI agent tries to spend money, you should not have to trust its explanation. This
project puts a small, mechanical **policy kernel** between the agent and the payment: every
spend request is reduced to a closed set of **facts pulled from authoritative sources**
(never the model's narration), and those facts are ground through a Datalog program that
returns `allow` / `deny` the same way every time. Same facts → same answer, and the facts
are true.

> **The canonical pitch is [`PITCH.md`](./PITCH.md).** (`hackathon-plan.html` and
> `pitch-deck.html` derive from it — see `CLAUDE.md` → "Keeping the pitch in sync".)

**All four pillars are built and enforced.** One-liner: *everyone else scopes the card; we prove the
decision.*

```bash
pnpm install && pnpm db:reset && pnpm build && pnpm test   # 411 tests
pnpm demo     # drive every pitch beat through the REAL hook; assert exit codes
pnpm proof    # independently re-verify the bundles the gate sealed
```

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
- **It's auditable — and the audit is *re-derivable*.** Every decision is sealed into a
  content-addressed **provenance bundle**: the decision, the exact facts, and for each fact the
  specific query / notary / declassifier it came from. `pnpm proof` re-runs the kernel on the
  recorded facts and checks the verdict falls out. An audit *log* is a claim a system writes about
  itself; a bundle can be checked by someone who trusts nothing. You cannot reseal your way out of
  arithmetic.
- **Untrusted content can't act.** Invoices and emails are wrapped at the boundary in a value that
  **refuses to become a string** (`${q}`, `String(q)`, `JSON.stringify(q)` all throw). It escapes
  only through a total declassifier into a **bounded codomain** — so an attacker's reachable set is a
  number we chose in advance, not "strings we failed to imagine."
- **Invoices are authenticated, not just matched.** A notary-signed statement binds the invoice
  bytes, the amount, and the vendor's **registered** domain, verified before money moves. A 3-way
  match compares documents to *each other*; three consistent forgeries pass it. (Scope stated plainly
  in [`packages/attestation/README.md`](./packages/attestation/README.md): real Ed25519 and real
  binding checks, **not** the TLSNotary MPC protocol.)

## Architecture

A request flows **down** through every pillar before a dollar moves. Enforcement comes from the
**topology**, not from the agent cooperating.

```
  agent calls  mcp__payments__pay_vendor
        │
        ▼
  ┌──────────────────────────────┐   raw SpendRequest — ALL of it untrusted transport,
  │      hook/evaluate.mjs       │   including the attestation blob. Used only as keys.
  │      (fail-closed hook)      │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐   PILLAR 3 — invoice + invoiceRef wrapped at the
  │      @ramp/quarantine        │   boundary. Cannot become a string. Escapes only
  │   (CaMeL: data cannot act)   │   via a total declassifier into a bounded codomain.
  └──────────────┬───────────────┘
                 │  a digest — never the bytes
                 ▼
  ┌──────────────────────────────┐   PILLAR 4 — Ed25519 signature vs a trusted notary
  │      @ramp/attestation       │   keyring, AND binding: invoice digest, the vendor's
  │  (authenticate, don't match) │   REGISTERED domain, amount, currency, freshness.
  └──────────────┬───────────────┘
                 │  attestation_present: a verified BOOLEAN (never a claim)
                 ▼
  ┌──────────────────────────────┐   AUTHORITATIVE facts:
  │   @ramp/ledger  (SQLite)     │   vendor_verified, daily_total_so_far, caps,
  │   + vendor registry          │   approved + cleared categories — and the exact
  └──────────────┬───────────────┘   SQL it ran, recorded as provenance.
                 │  Facts  (the frozen contract, @ramp/shared)
                 ▼
  ┌──────────────────────────────┐   PILLAR 1 — policy.dl (Souffle) ⇄ TS reference kernel
  │   @ramp/gate  PolicyKernel   │   deny dominates; deterministic, pure, no clock.
  └──────────────┬───────────────┘
                 │  Decision { decision, reasons, firedRules }
                 ▼
  ┌──────────────────────────────┐   PILLAR 2 — seal a content-addressed bundle:
  │      @ramp/provenance        │   decision + facts + where every fact came from.
  │  (re-derivable, not logged)  │   `pnpm proof` re-runs the kernel and checks.
  └──────────────┬───────────────┘
                 │
       exit 0 = allow  ·  exit 2 = deny   ──►  @ramp/dashboard re-verifies in your BROWSER
```

**Where the clock lives.** Freshness needs wall time, so exactly one place reads it: the hook, in the
fact-gathering layer, alongside the DB reads. It passes `now` *into* the attestation verifier (which
stays pure), and only the resulting boolean crosses into the kernel. Gathering facts may read the
world; **deciding** may not. That split is what keeps *"same Facts → same Decision"* true — and it's
what makes pillar 2's re-derivation possible at all.

The seam between "facts" and "allow/deny" is a single interface, `PolicyKernel`, with **two
implementations behind it**: a TypeScript **reference kernel** (the golden oracle, always
available, zero deps) and an optional **WASM kernel** compiled from `policy.dl`. Callers are
implementation-agnostic; a parity test cross-checks the two.

## Workspace map

| Workspace             | Path                   | Depends on        | What it is                                                            |
| --------------------- | ---------------------- | ----------------- | -------------------------------------------------------------------- |
| **`@ramp/shared`**    | `packages/shared/`     | —                 | The **frozen contract**: `Facts`, `Decision`, `RuleId`, `PolicyKernel`, `SpendRequest`, fact translation, `canonicalJson`. Zero runtime deps; browser-safe; imported by everyone. |
| **`@ramp/gate`**      | `packages/gate/`       | `@ramp/shared`    | **Pillar 1** — the **policy kernel** (hero). `policy.dl` (Souffle) is the source of truth; the TS reference kernel mirrors it line-for-line; optional WASM build. |
| **`@ramp/provenance`**| `packages/provenance/` | `@ramp/shared`    | **Pillar 2** — decision bundles + `verifyBundle`, the auditor's function. Does **not** depend on `@ramp/gate`: an auditor brings their own kernel. |
| **`@ramp/quarantine`**| `packages/quarantine/` | `@ramp/shared`    | **Pillar 3** — the CaMeL wrapper + total declassifiers into bounded codomains. |
| **`@ramp/attestation`**| `packages/attestation/`| `@ramp/shared`   | **Pillar 4** — Ed25519 notary attestation, canonical domain-separated signing, binding checks. |
| **`@ramp/ledger`**    | `packages/ledger/`     | shared + provenance | The **authoritative fact source** (SQLite) + vendor registry. Pure DB reads — never model narration. Records the exact SQL it ran as provenance. |
| **`@ramp/payments-mcp`** | `apps/payments-mcp/`| `@ramp/shared`    | Stub MCP server exposing `mcp__payments__pay_vendor`. An honest non-enforcing stub — enforcement lives in the hook. |
| **`@ramp/dashboard`** | `apps/dashboard/`      | shared + provenance + gate | Vite + React. The **Audit page re-verifies bundles in your browser** with WebCrypto and the real kernel. |
| The gate              | `hook/` (+ `.claude/` shim) | all of the above | The fail-closed `PreToolUse` enforcement point — the ONLY place policy is enforced. |

**Ownership:** @Srujyama owns the gate + the three pillars + shared contract + repo wiring;
@neilporw owns the ledger fact source + payments MCP stub; @JonKach owns the dashboard shell. See
[`.github/CODEOWNERS`](./.github/CODEOWNERS).

## Quickstart

```bash
# Prereqs: Node >= 24 (see .nvmrc) and pnpm 11.13.0 (corepack enable).
nvm use
corepack enable

pnpm install         # install the whole workspace
pnpm db:reset        # build the demo ledger from schema.sql + seed.sql
pnpm build           # tsc build every package
pnpm test            # run every workspace's node:test suite (411 tests)

pnpm demo            # drive EVERY pitch beat through the real hook, assert exit codes
pnpm proof           # independently re-verify the bundles the gate just sealed
pnpm dev             # dashboard (Vite) — the Audit page re-verifies in your browser
pnpm mcp             # (separately) run the stub payments MCP server
```

### Auditing this without trusting us

`pnpm proof` verifies bundles — by importing our code, from our repo. If you're auditing us that's
worth nothing: you'd be asking the thing under audit whether it's honest. So there's one file with
**zero dependencies** you can copy anywhere:

```bash
cp verify-ramp-proof.mjs /somewhere/empty/
cd /somewhere/empty && node verify-ramp-proof.mjs bundles/          # no install, no network
node verify-ramp-proof.mjs bundles/ --gate-key gate-public.pem      # also check authenticity
```

It re-derives every decision from its own recorded facts and checks the recorded verdict falls out.
You don't have to trust our monorepo — only ~300 lines you can read in ten minutes, and `node`. CI
runs it from an empty directory, so the "zero deps" claim can't quietly rot.

It's a **second kernel**, which is a real risk: two implementations can disagree, and a verifier that
disagrees with the gate is worse than none. That's handled the same way the repo handles its WASM
kernel — a parity test cross-checks it against the reference oracle on the golden cases and **5000
randomized fact sets**, and CI fails on a single character of drift.

**`pnpm test` is not the bar; `pnpm demo` is.** The tests prove the *kernel* works. `pnpm demo`
spawns `hook/evaluate.mjs` as a real subprocess — exactly how Claude Code invokes it — and asserts
the **exit code**, which is the actual contract with Claude Code. A green kernel behind a broken
hook is a broken product: that is exactly how a fail-open allowing a $400 over-limit payment once
survived a fully green suite. Both `pnpm demo` and `pnpm proof` run in CI, so the pitch is
executable and cannot quietly drift into fiction.

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

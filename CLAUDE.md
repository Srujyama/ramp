# ramp/ — Provable Agent Spend (Claude Code project notes)

Auto-loaded every session in this repo. Read this before doing pitch or backbone work.

## What this project is

**Provable Agent Spend** — make every AI-agent payment decision *provable*, not trusted. A
deterministic Datalog policy kernel sits in the execution path as a **non-bypassable `PreToolUse`
hook**, fed only by **authoritative, cryptographically-attested inputs**. One-liner:
**"Everyone else scopes the card. We prove the decision."** Full pitch: **[`PITCH.md`](./PITCH.md)**.

## The pitch has ONE source of truth: `PITCH.md`

There are three pitch artifacts, and they must stay consistent:

| File | What it is | Audience |
| --- | --- | --- |
| **`PITCH.md`** | **Canonical pitch — the single source of truth.** | Humans + every Claude session |
| `hackathon-plan.html` | The build/strategy plan (published as an Artifact). | The team, during the build |
| `pitch-deck.html` | The presentation slide deck (published as an Artifact). | Judges, live |

### Keeping the pitch in sync (IMPORTANT — applies to you and every other Claude session)

When anyone asks you to "update the pitch", change the messaging, add a new
differentiator/rebuttal, or fold in new research:

1. **Edit `PITCH.md` first.** It is authoritative. Bump its "Last substantive update" date.
2. **Propagate the same change to BOTH `hackathon-plan.html` and `pitch-deck.html`** so the plan
   and the deck never drift from the canonical pitch or from each other. Do not update one and
   leave the others stale.
3. **Re-publish both artifacts to their existing URLs** (do not mint new ones):
   - Plan: `hackathon-plan.html` → artifact `https://claude.ai/code/artifact/30f5b98e-903f-4f8d-80f6-aaab5d80a2de`
   - Deck: `pitch-deck.html` → artifact `https://claude.ai/code/artifact/bd909a82-812b-4658-b976-7519a6209420`
   (If a URL ever goes stale, use `Artifact` `action:"list"` to find the current one, then pass it as `url`.)
   Republish by calling `Artifact` with the same file path (same-session) or the `url` param
   (cross-session) — see the Artifact tool's update rules.
4. **Commit via a PR** (see below) — `main` is protected.

If you only have time to touch one, touch `PITCH.md` and say clearly that the two HTML artifacts
still need propagation — never silently leave them inconsistent.

## Collaboration / git flow (`main` is protected)

- `main` requires: a PR, **1 code-owner review**, and the CI **`build`** check green. No direct
  pushes, no force-push. Branch → PR → review → merge.
- Ownership (`.github/CODEOWNERS`): **@Srujyama** = `@ramp/gate` + `@ramp/shared` + the security
  pillars + `@ramp/client` + repo wiring + pitch artifacts; **@neilporw** = `@ramp/ledger` +
  `@ramp/payments-mcp`; **@JonKach** = `@ramp/dashboard`.
- **Single-instance-service caution** does NOT apply here (this is a normal web repo, no Studio/MCP
  bridge). Ignore the global note about competing servers for this project.

## The monorepo (all four pillars built & green)

pnpm + TypeScript, Node 24. `pnpm install && pnpm db:reset && pnpm build && pnpm test` → all green
(**544 tests**; the 2 wasm-parity tests run when the WASM kernel is built — the `wasm kernel —
4-way parity` CI job does this — else they skip cleanly). Then `pnpm demo` drives every PITCH beat
through the real hook and `pnpm proof` re-verifies the sealed bundles.

| Workspace | Pillar | What it is |
| --- | --- | --- |
| `@ramp/shared` | — | Frozen contract: `Facts`/`Decision`/`RuleId`/`PolicyKernel`/`translateToFacts`/`canonicalJson`. |
| `@ramp/gate` | **1** | Kernel: `policy.dl` Datalog spec + TS reference oracle + a hand-written Rust→WASM mirror, cross-checked by a parity test (now a real CI job, not a skip). |
| `@ramp/provenance` | **2** | Content-addressed decision bundles + the independent `verifyBundle`. |
| `@ramp/quarantine` | **3** | CaMeL wrapper + total declassifiers into bounded codomains. |
| `@ramp/attestation` | **4** | Ed25519 notary attestation + binding checks. |
| `@ramp/ledger` | — | Authoritative facts via `node:sqlite` (+ records its own provenance), the append-only **decision log**, tamper-evident **proofs**, the read-only **HTTP bridge**, the **policy simulator**, and the shared **purchase lifecycle**. |
| `@ramp/client` | — | The typed agent **SDK** (`createRampClient`) — build a provable spending agent in a few lines. A convenience over the real lifecycle, not a bypass. |
| `@ramp/payments-mcp` | — | **Self-enforcing** MCP tool — drives the purchase lifecycle itself, so it is safe to call with no hook present. The 2nd independent gate over the same kernel. |
| `@ramp/dashboard` | — | Vite+React **audit console**: Overview / Decisions / Decision detail / Policy + simulator + **Pricing**. Decision detail **re-derives the decision in your browser** with the real kernel. |
| `@ramp/control-plane` | — | **DEMO-ONLY** control plane (separate process/port, `pnpm control-plane`) — live model pricing, UI-triggered **real** gated transactions via `requestPurchase` (`POST /transaction`), and typed INPUT-table admin (`POST /agents`, `PATCH /policy` → `agents`/clearances/`policy_limits` only). **NOT the audit bridge, NOT the gate**; never writes a decision, never decides. |

Scripts: `pnpm demo` (drive the beats), `pnpm proof` (independent audit), `pnpm notary` (mint an
attestation), `pnpm dev` (console), `pnpm --filter @ramp/ledger bridge` (the read-only bridge the
console reads — start both for the dashboard). Full contributor guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Frozen invariants — do not drift (see `CONTRIBUTING.md` for the full list)
- **Facts field names** map 1:1 to `policy.dl` input relations; adding a fact means editing
  facts.ts **and** policy.dl **and** the ledger fact-source **and** the reference kernel.
- **Seed prior daily total is `1140`, NOT `1200`** — deliberately, so the hero happy path allows
  (`1140 + 340 ≤ 1500`). Do not "fix" it.
- Money is **integer whole units** everywhere (exact kernel arithmetic), enforced by
  `deny/malformed_facts`.
- Facts come from the **ledger/registry/structured args**, never model narration (the anti-injection
  seam). The hook **fails closed** (any error → deny).

### Two proof systems, on purpose — do not "de-duplicate" them
`@ramp/ledger`'s `LedgerProof` proves **integrity** ("this record was not altered"). `@ramp/provenance`'s
bundle proves **soundness** ("this decision follows from these facts", by re-running the kernel). They
look redundant and are not: a perfectly intact record of a WRONG decision passes the first and fails
the second. Both are written per decision. Deleting either loses a real guarantee.

### Three things that look like bugs but are load-bearing — read before "fixing"
- **`deny/malformed_facts` has no rule in `policy.dl`.** Not drift. Soufflé's `number` is an INTEGER
  type, so NaN/floats are unrepresentable there; TypeScript's is IEEE-754 and every comparison
  against NaN is false — which made a `NaN` amount **payable**. The TS/Rust mirrors enforce at
  runtime what Soufflé enforces in its type system.
- **`DEFAULT_DB_PATH` is absolute, and the hook uses `openLedgerStrict`.** A relative path resolved
  per-caller, so the hook and `pnpm db:reset` read different files; auto-provisioning then turned the
  wrong path into a fresh zero-spend ledger that **allowed**. Never make it cwd-relative, and never
  let the enforcement path auto-provision.
- **`packages/quarantine/src/encode.ts` avoids `JSON.stringify`.** It throws on BigInt/circular
  input, which made `quarantine()` — the boundary wrapper — throw on attacker-chosen input.

## Verify before claiming done

The whole thesis is provability — hold the repo to the same bar. After a change to the gate/ledger/
hook, run **`pnpm demo`**: it spawns `hook/evaluate.mjs` as a real subprocess (exactly how Claude
Code invokes it) for every PITCH beat and asserts the **exit codes**, not just that tests pass. Then
**`pnpm proof`** to confirm the sealed bundles still verify. Both run in CI. A green `pnpm test` with
a broken hook is a broken product — that is precisely how the $400 fail-open survived.

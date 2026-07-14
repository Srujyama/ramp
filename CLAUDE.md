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
- Ownership (`.github/CODEOWNERS`): **@Srujyama** = `@ramp/gate` + `@ramp/shared` + repo wiring +
  pitch artifacts; **@neilporw** = `@ramp/ledger` + `@ramp/payments-mcp`; **@JonKach** =
  `@ramp/dashboard`.
- **Single-instance-service caution** does NOT apply here (this is a normal web repo, no Studio/MCP
  bridge). Ignore the global note about competing servers for this project.

## The monorepo (already built & green)

pnpm + TypeScript, Node 24. `pnpm install && pnpm db:reset && pnpm build && pnpm test` → all green
(25 tests pass; 1 wasm-parity skip is expected without Soufflé/wasm-pack). Workspaces:
`@ramp/shared` (frozen contract: `Facts`/`Decision`/`RuleId`/`PolicyKernel`/`translateToFacts`),
`@ramp/gate` (kernel: real `policy.dl` + TS reference oracle + optional WASM), `@ramp/ledger`
(authoritative facts via `node:sqlite`), `@ramp/payments-mcp` (stub MCP server), `@ramp/dashboard`
(Vite+React shell). Full contributor guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Frozen invariants — do not drift (see `CONTRIBUTING.md` for the full list)
- **Facts field names** map 1:1 to `policy.dl` input relations; adding a fact means editing
  facts.ts **and** policy.dl **and** the ledger fact-source **and** the reference kernel.
- **Seed prior daily total is `1140`, NOT `1200`** — deliberately, so the hero happy path allows
  (`1140 + 340 ≤ 1500`). Do not "fix" it.
- Money is **integer whole units** everywhere (exact kernel arithmetic).
- Facts come from the **ledger/registry/structured args**, never model narration (the anti-injection
  seam). The hook **fails closed** (any error → deny).

## Verify before claiming done

The whole thesis is provability — hold the repo to the same bar. After a change to the gate/ledger/
hook, actually **drive the allow/deny/injection beats** (pipe a sample `tool_input` into
`hook/evaluate.mjs`) and confirm exit codes, not just that tests pass. See `PITCH.md` → "The live
demo" for the exact scenarios.

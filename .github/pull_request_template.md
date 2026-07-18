<!--
  Warrant — Pull Request
  Keep PRs scoped to ONE workspace where possible; CODEOWNERS routes review to the
  right owner automatically. See CONTRIBUTING.md for the full flow.
-->

## What & why

<!-- One or two sentences: what this PR changes and the reason. -->

## Workspace(s) touched

<!-- Tick the packages this PR modifies. CODEOWNERS will request the matching reviewer. -->

- [ ] `@ramp/shared` — the frozen contract (facts, decision, kernel interface, translate)
- [ ] `@ramp/gate` — the policy kernel (reference / wasm) + `policy.dl`
- [ ] `@ramp/ledger` — authoritative fact source (SQLite)
- [ ] `@ramp/payments-mcp` — the stub MCP server
- [ ] `@ramp/dashboard` — the Vite/React shell
- [ ] `.claude/` — the fail-closed PreToolUse hook
- [ ] repo infra (`.github/`, root config)

## Contract safety

<!-- The security argument depends on these staying frozen. Confirm you did NOT drift them. -->

- [ ] `Facts` field names unchanged (they map 1:1 onto `policy.dl` input relations).
- [ ] `RuleId` string union unchanged (shared by both kernels, dashboard, audit).
- [ ] `Decision` shape unchanged: `{ decision, reasons, firedRules }`.
- [ ] No security-critical fact reads from model narration — only ledger DB / vendor
      registry / structured tool args.
- [ ] If a `Facts` field was added, I edited BOTH `facts.ts` AND `policy.dl` (plus the
      ledger fact-source + reference kernel).

## Checks

- [ ] `pnpm -r typecheck` passes.
- [ ] `pnpm -r build` passes.
- [ ] `pnpm -r test` passes.
- [ ] (If I touched the gate) reference-kernel golden cases still pass.

## Notes for the reviewer

<!-- Anything non-obvious: seed-number reasoning, deny-order, optional wasm path, etc. -->

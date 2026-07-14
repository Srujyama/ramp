# @ramp/dashboard

A Vite + React **shell** for Provable Agent Spend. Phase 0 ships real routing
and the design system with honest "no data yet" panels — it is **not** the hero
of the project and enforces nothing. The security boundary is the PreToolUse
hook (`hook/evaluate.mjs`) and the deterministic kernel in `@ramp/gate`, never
this UI.

## What's here

- **Routing** (`react-router-dom`): `/` Overview · `/cards` Cards & Limits ·
  `/decisions` Decisions (provenance) · `/audit` Audit.
- **Design tokens** (`src/theme.css`): cool blue-slate neutrals, a single
  verification-green accent reserved for a proven **allow**, and semantic
  deny-red / warn-amber / info-blue. Light + dark via `prefers-color-scheme`
  and an explicit `[data-theme="dark"]` toggle in the header.
- **Components**: `Sidebar`, `StatTile` (KPI tile that renders an honest `—`
  placeholder when it has no value yet).
- Imports `RuleId` and fact-source names from `@ramp/shared` so the shell stays
  in lockstep with the frozen contract.

## Run

```sh
pnpm --filter @ramp/dashboard dev      # vite dev server
pnpm --filter @ramp/dashboard build    # tsc -b && vite build
pnpm --filter @ramp/dashboard preview  # preview the production build
```

## Not the hero

Placeholders are deliberate and labelled. Real data (decisions, provenance,
audit traces) will be fed from the ledger and audit trail in a later phase. Do
not lead a demo with this page — lead with the gate.

# Provable Agent Spend — Design System

The visual system for a **read-only audit console** with an enterprise-
infrastructure register. Every choice serves legibility of *proof*, not
decoration. Tokens live in [`src/theme.css`](src/theme.css); this document
records the rules behind them.

## Color tokens

Cool blue-slate neutrals carry the whole surface. Color is semantic, never
ornamental.

### Neutrals (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f7f8fa` | `#0d1117` | page background |
| `--surface` | `#ffffff` | `#161b24` | cards, header, sidebar |
| `--surface-2` | `#f1f3f7` | `#1d2430` | insets, table headers, skeletons |
| `--ink` | `#131924` | `#eef2f8` | primary text |
| `--ink-muted` | `#4a5464` | `#a4afc0` | secondary text (darkened for AA) |
| `--ink-faint` | `#6b7382` | `#6b7688` | small/faint text (passes 4.5:1) |
| `--border` / `--border-strong` | `#e3e7ee` / `#cdd4e0` | `#262d3a` / `#333c4c` | hairlines, inputs |

### Semantic colors

| Meaning | Token | Soft bg | AA text ink |
|---|---|---|---|
| **proven success** | `--accent` (verification green) | `--accent-soft` | `--accent-ink` |
| denial | `--deny` (red) | `--deny-soft` | `--deny-ink` |
| warning / attention | `--warn` (amber) | `--warn-soft` | `--warn-ink` |
| information | `--info` (blue) | `--info-soft` | `--info-ink` |

### The verification-green rule

`--accent` (green) is reserved for **proven success only** — a policy `allow`, a
`verified` proof, a `settled` sandbox payment. It is never spent on decoration,
brand, or chrome. Consequences baked into the system:

- The brand mark is solid infra-ink (`--ink`), **not** a green gradient.
- The progress bar uses `--info` (blue), turning `--deny` (red) only when over
  limit — never green.
- No decorative gradients anywhere; both were removed so green stays meaningful.
- Active nav carries the accent only on the *icon* plus a weight bump, on an
  AA-safe neutral background — never low-contrast green-on-green text.

### Theming

Both palettes ship. Dark applies two ways: automatically via
`@media (prefers-color-scheme: dark)` (scoped `:root:not([data-theme="light"])`),
and forced via an explicit `:root[data-theme="dark"]` override. The header
toggle initializes from OS preference, can force either theme, and persists the
choice to `localStorage`. `color-scheme` is set so native controls match.

## Typography

- **Stack:** system sans (`--font-sans`) for UI; `--font-mono` for ids, digests,
  rule slugs, and agent handles.
- **Scale:** a fixed rem/px scale (product register), not fluid type — hero 26px,
  page title 22px, body 14px, chips ~11.5px.
- **Figures:** `font-variant-numeric: tabular-nums` on every amount, KPI value,
  and table number so columns align and values don't jitter.
- Tight negative letter-spacing on headings; `text-wrap: balance` on the hero.

## Component inventory

- **Status chips** (`.chip`) — pill + dot + text, one per semantic tone, drawn
  on `-soft` backgrounds with AA-safe `-ink` text.
- **Responsive decision table** (`.dtable`) — a real 2D grid that collapses to
  stacked cards at ≤860px, relabeling each cell from its `data-label`. Corrupt
  rows get a `.corrupt-row` tint and a flag.
- **Execution timeline** (`.flow`-based stepper) — the primary decision-detail
  visualization: six stages (Agent request → Trusted facts loaded → Policy
  evaluated → Decision recorded → Proof validated → Payment executed/blocked/
  failed), each with its own state pill, a deterministic explanation, and a
  copyable id. The four separable trust claims are folded in as stages here
  rather than a separate `.trust-strip`, so the failure modes (denied / payment
  failed / tampered / corrupt / not executed) never blur together.
- **Provenance flow** (`.flow`) — a vertical stepped list with a connecting spine
  and per-node tone; the terminal step stays honest (executed vs. blocked vs. not
  executed).
- **Recent activity feed** (Overview) — the five newest decisions as linked rows
  with outcome/proof/payment chips, a deterministic explanation, and an honest
  relative "Updated Xs ago".
- **Policy simulator** (Policy page) — a labeled form + seeded scenario buttons,
  an ALLOWED/DENIED verdict chip, the deterministic explanation, fired rules
  (title + raw id), a facts-derived checks checklist, the policy digest, and a
  "Simulation only" label.
- **Explanation cell** (`.row-explain`) — the deterministic plain-English summary
  that leads each decision row/entry, with the raw rule tags kept beneath it.
- **KPI stat tiles** (`.stat-tile`) — labeled figure with a tone dot; render a
  mono `—` placeholder when there is no value, never a fake number.
- **Skeletons** (`.skeleton`) — transform-based shimmer (compositor-only), used
  for loading rows and cards.
- **Honest state cards** (`.state-card`, `.empty`) — empty, error/offline (with
  the exact start command + Retry), and not-found.
- **Workflow strip** (`.workflow`) — the six-step live path on the Overview.
- **Sandbox indicator** (`.sandbox-note`) — a subtle, single-line "Demo
  environment · Sandbox payments" strip (the former full-width amber banner was
  retired as visual noise); the full "no real money moves" detail is its tooltip.
- **Connection pill** (`.conn`) — header live/offline/connecting indicator.
- Plus: filter bar, buttons, key/value grids (`.kv`), proof/receipt boxes,
  copyable ids, pagination footer.

## State vocabulary

Every state is real and has a dedicated treatment — nothing is faked or hidden:

| State | Treatment |
|---|---|
| loading | skeletons |
| empty | "no decisions yet — trigger a `pay_vendor` call" |
| bridge unavailable | error card with exact start command + Retry; header shows "Bridge offline" |
| malformed response | typed error state, not a crash |
| 404 not found | "decision not found" |
| corrupt record | flagged inline, never hidden |
| tampered proof | verification chip shows ✕ (`Tampered`) |

Proof verification is four-valued everywhere it appears: `ok` (**Proof valid**) /
`mismatch` (Tampered) / `corrupt` (Corrupt) / `absent` (No proof). The label is
"Proof valid", never a bare "Verified" — proof integrity is a specific,
independently-recomputed claim, not a vague thumbs-up.

## Responsive behavior

- App shell is a sidebar + content grid; below 780px the sidebar becomes a
  horizontal top bar and its footer hides.
- The decision table collapses to labeled cards at ≤860px via `data-label`.
- KPI rows, trust ladder, and tile grids use `auto-fit`/`auto-fill` minmax
  tracks, so they reflow without breakpoints.
- Content is width-capped (`max-width: 1180px`) for line length.

## Motion & reduced motion

Motion is **state-conveying only**, never ambient. The progress bar animates
`transform: scaleX()` (compositor-only, no layout thrash), not `width`.
Skeletons shimmer via a translated pseudo-element. All animation is disabled
under `@media (prefers-reduced-motion: reduce)`.

## Accessibility

- Skip-link to `#main`; visible `:focus-visible` rings (`--info`, 2px).
- Labeled nav icons and `aria-*` on the theme toggle and connection pill.
- AA contrast on all status chips (`-ink` tokens tuned against `-soft` bgs);
  `--ink-muted` / `--ink-faint` darkened specifically for small-text contrast.
- **Status is never color-only** — every chip, node, and rung pairs its color
  with a text label and, where used, an icon.

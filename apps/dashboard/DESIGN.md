# Warrant — Design System

The visual system for a **business-facing spend console**: agent spend cards, live
vendor/category breakdowns, and every purchase independently provable — presented as
a sleek consumer tool, not exposed backend plumbing. Built on **Tailwind CSS v4** +
hand-authored shadcn-style Radix primitives. Tokens live in
[`src/index.css`](src/index.css); this document records the rules behind them.

> Superseded the Phase-0 "enterprise-infrastructure audit console" register (cool
> blue-slate neutrals, reserved verification-green). That system is gone; this one
> replaces it end to end, including every page and component.

## Direction: "Reference lime"

Styled after a clean modern fintech console (see `inspo/FinancialDashboard.png`):
soft gray canvas, white rounded cards with quiet shadows, one lime-green accent used
with intention, amber for attention/escalation, red reserved for deny/flag. Light-first;
dark ships in lockstep, not as an afterthought.

## Color tokens

Cool neutrals carry the surface; lime is the one accent spent with intention
(~60/30/10: mostly neutral structure, a little secondary tone, a slice of accent).

### Neutrals (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | `#eef0f3` | `#0c0e11` | page background |
| `--surface` | `#ffffff` | `#15171b` | cards, header, sidebar |
| `--surface-sunken` | `#f5f6f9` | `#1b1e23` | insets, table headers, skeletons |
| `--surface-hover` | `#ebedf2` | `#21242a` | hover state on rows/nav |
| `--field` | `#f2f3f7` | `#101214` | inputs — slightly *darker* than canvas, never lighter |
| `--ink` / `--ink-muted` / `--ink-faint` | `#14161a` / `#5b616d` / `#8b92a0` | `#edeef1` / `#9ca2ad` / `#6b717c` | primary / secondary / metadata text |
| `--line` / `--line-strong` | `#e7e9ef` / `#d7dae3` | `rgba(255,255,255,.08)` / `.14` | hairlines, borders |

### Accents

| Meaning | Token | Soft bg | AA ink |
|---|---|---|---|
| primary / allow / proof-verified | `--lime` | `--lime-soft` | `--lime-ink` |
| attention / escalate / needs approval | `--amber` | `--amber-soft` | `--amber-ink` |
| deny / flag / critical | `--flag` | `--flag-soft` | `--flag-ink` |
| informational (rare) | `--info` | `--info-soft` | `--info-ink` |

`--verify` aliases `--lime` — a verified proof is drawn from the same accent as
"allow," since this register is a business console, not the old console's
single-reserved-green audit register.

### Chart tokens (separate from UI accents — read this before touching either)

`--chart-allow` / `--chart-escalate` / `--chart-deny` / `--chart-neutral` are
**deliberately different hex values** from `--lime`/`--amber`/`--flag`, even though
they mean the same thing. UI accents (badge text on a soft background, button fills)
want high lightness for legibility; solid chart fills (bar segments, donut slices)
need a stricter OKLCH lightness band *and* colorblind-safe hue separation between
adjacent marks. The two token sets were validated separately with the `dataviz`
skill's `validate_palette.js` — **do not hand-edit either without re-running it**:

```
node scripts/validate_palette.js "#7fb239,#d97706,#e2503b" --mode light
node scripts/validate_palette.js "#5f9c2c,#b8721a,#c94a38" --mode dark
```

The first attempt (`--lime` reused as `--chart-allow`, `--amber` reused as
`--chart-escalate`) **failed** the validator: ΔE 3.7 for protanopia, far below the
usable floor — lime green and amber sit too close for red-green colorblind users.
The shipped chart trio passes. If a future chart introduces a new hue, validate it
before shipping, not after.

### Agent Card face (its own fixed tokens)

`--cardface` / `--cardface-2` / `--cardface-ink` / `--cardface-ink-muted` /
`--cardface-ring` are defined **once**, unconditionally — not overridden in the dark
block. A physical corporate card doesn't repaint when your phone flips to dark mode;
the card face stays a fixed dark olive-charcoal (tied to the lime hue, not neutral
black) across both app themes, with a subtle lime-tinted ring border. This was a
deliberate fix: the first version reused `--surface`'s dark value verbatim for
`--cardface`, so in dark mode the signature card blended into every other panel and
lost the "this is an object" quality it has in light mode. Never let `--cardface`
collide with `--surface` in either theme again.

### Theming

Light applies by default. Dark applies two ways: automatically via
`@media (prefers-color-scheme: dark)` (scoped `:root:not([data-theme="light"])`), and
forced via an explicit `:root[data-theme="dark"]` override, set by `useTheme` and
persisted to `localStorage`. An inline script in `index.html` reads that storage key
and stamps `data-theme` on `<html>` **before first paint**, so there is no flash of
the wrong theme on reload. `color-scheme` is set so native controls match.

## Typography

- **Display** (`--font-display`, Instrument Sans): the landing page's hero/section
  headlines only (`text-hero` / `text-display` utilities) — apply `font-display`
  explicitly alongside them; the size tokens don't carry a family. This is the one
  place the console allows itself real typographic personality.
- **Body/UI** (`--font-sans`, Inter): everything else — page titles, cards, tables,
  forms. Small-size legibility across the whole product matters more than
  personality here.
- **Mono** (`--font-mono`, IBM Plex Mono): ids, digests, agent/vendor slugs inside
  `CopyId`.
- **Figures:** `.tabular` (`font-variant-numeric: tabular-nums`) on every amount, KPI
  value, and table number.
- Tight negative letter-spacing on `text-hero`/`text-display`; `text-wrap: balance`
  on headings, `pretty` on body copy.

## Component inventory

- **Agent Card** (`components/AgentCard.tsx`) — the signature element. A virtual
  corporate card per agent: masked pseudo card-number (`maskedCardNumber`, derived
  deterministically from the agent id — decorative, there is no real card number),
  daily spend vs. org daily limit as a usage bar, cleared-category pills, a trust
  seal (`N/N verified`, switches to a warning tone the moment any decision is
  flagged), and the agent's top vendor. Every field traces to `lib/agents.ts`, which
  derives it from the real `/decisions` feed — nothing on the card is invented.
  Supports `linked={false}` for the static hero rendering on the agent's own detail
  page (a self-link there would be dead weight).
- **Chart primitives** (`components/charts/*`) — hand-rolled, tokenized SVG, no
  charting dependency: `StackedBar` (daily decision volume by outcome, rounded only
  at the top, 2px surface gaps between stacked segments, per-bar hover tooltip) and
  `Donut` (a *ranked* breakdown — vendor/category spend — drawn from a single-hue
  sequential ramp rather than a categorical rainbow, since it's a supporting widget
  and the console spends its one accent with intention; caps at 5 named slices, the
  rest fold into a neutral "Other").
- **Dashboard widgets** (`components/widgets/*`) — self-contained cards consumed by
  `Dashboard.tsx`, each taking the shared `DecisionsWindowProvider` data as a prop:
  `SpendOverviewWidget`, `TrustSummaryWidget`,
  `RecentActivityWidget`, `CategoryBreakdownWidget`, `VendorBreakdownWidget`,
  `LimitUsageWidget` (org-wide caps reference — the Agent Card carries its own
  spend-vs-limit bar), and `PlaceholderWidget` (see below).
- **"Add widget" + placeholder widgets** (`lib/useWidgetPrefs.ts`) — real modularity,
  not decoration: widget visibility is a `Record<string, boolean>` persisted to
  `localStorage`, toggled from a dropdown in the Dashboard header. Two widgets
  (`costPerQuery`, `providerBreakdown`) represent metrics that genuinely don't exist
  in the ledger yet — they default **off**, and when added they render as an
  explicit "not tracked by the ledger yet" invitation, never mock numbers. This is
  the front line of "real-derived only": a widget for data that doesn't exist yet
  is honest; illustrative numbers standing in for it would not be.
- **Execution timeline** (`components/ExecutionTimeline.tsx`) — the primary
  decision-detail visualization: the six real stages (`lib/timeline.ts`'s
  `buildTimeline`) as a vertical stepper with a connecting spine, a state pill per
  stage (Done/Blocked/Failed/Corrupt/Skipped/Pending), the relevant trust chip
  folded into its stage (a deny reads "Blocked" *in the Policy-evaluated stage*, not
  as a separate card), and a copyable id/digest where one exists.
- **Provenance flow** (`components/ProvenanceFlow.tsx`) — the shorter five-step
  story (`lib/provenance.ts`'s `decisionFlow`), same spine treatment, with fact
  sources listed when the record carries a provenance graph.
- **Re-derivation** (`components/Rederive.tsx`) — the strongest claim in the
  console, unchanged in logic across the redesign: re-runs the *real* policy kernel
  (`@ramp/gate/reference`) on the record's stored facts, in the browser, and
  compares it to the recorded decision. Three honest states: match (green, "✓
  Re-derived in your browser"), mismatch ("✗ Does not follow" — a distinct, loud red
  state, not silently merged into "corrupt"), unavailable (no facts/decision to
  check). Re-skinned to Tailwind for this redesign; the verdict logic was not
  touched.
- **Status chips** (`components/StatusChip.tsx` over `components/ui/badge.tsx`) —
  one `Badge` component, five `tone`s (`accent`/`deny`/`warn`/`info`/`neutral`)
  matching `lib/format.ts`'s `Tone`. A dot precedes the label always — status is
  never color-only.
- **Honest state primitives** (`components/ui/state-card.tsx`) — `StateCard`
  (empty/not-found, optional `onRetry`) and `BridgeErrorState` (keyed on
  `BridgeError.kind`: `unavailable` → "Ledger bridge unavailable" with the exact
  start command; `malformed` → version-mismatch hint; `not_found` → "Decision not
  found"; anything else → generic, still with Retry).
- **Responsive tables → card-stacks** — the Activity and Vendors tables collapse to
  one card per row below `md` (`md:hidden` card list / `hidden md:block` table), not
  a horizontally-scrolling table. A wide table with several columns scrolled out of
  view produces visually broken-looking row heights on a phone (the tallest,
  off-screen cell still sets the row height) — verified broken in this redesign,
  fixed by the card-stack, not by hiding columns.
- **Mobile nav** (`app/AppLayout.tsx`'s `MobileNav`) — the sidebar is `max-lg:hidden`;
  below that a hamburger button opens a `Dialog`-based drawer with the same nav
  list. (The sidebar hiding with no replacement was a real gap caught during the
  responsive pass, not a design choice — always verify a hidden nav has a mobile
  equivalent before shipping.)
- **Notifications** (`AppLayout.tsx`'s `NotificationsMenu`) — real data, not a
  decorative bell: lists decisions that are `escalate` (needs a human) or flagged
  (tampered/corrupt proof, failed settlement), each linking to its detail page.
- Plus: `CopyId` (click-to-copy, monospace), `Skeleton` (compositor-only shimmer),
  shadcn-style primitives (`Button`, `Card`, `Dialog`, `DropdownMenu`, `Select`,
  `Tabs`, `Tooltip`, `Input`, `Progress`, `Avatar`) under `components/ui/`.

## State vocabulary

Unchanged commitment from the prior system — every state is real, nothing is faked
or hidden:

| State | Treatment |
|---|---|
| loading | skeletons |
| empty | "no decisions yet — trigger a `pay_vendor` call" |
| bridge unavailable | error card, exact start command, Retry; sidebar shows "Bridge offline" |
| malformed response | typed error state, not a crash |
| 404 not found | "Decision not found" |
| corrupt record | flagged inline (⚠ Corrupt), never hidden |
| tampered proof | verification chip shows "Tampered" |
| escalate | its own amber "Needs approval" / "Held" chips — never rendered as a deny, never rendered as an allow |

Proof verification stays four-valued everywhere: `ok` ("Proof valid") / `mismatch`
("Tampered") / `corrupt` ("Corrupt") / `absent` ("No proof").

Decision outcome stays **three**-valued everywhere, including places that look like
they'd only need two: `allow` / `deny` / `escalate`. This redesign found and fixed
several places that had silently regressed to two-valued logic after `escalate` was
added upstream (`explainDecision`, `explainSimulation`, `paymentChip`, and
`decisionFlow`'s "decision"/"payment" steps) — each had escalate falling through to
either a deny-shaped or "no decision" message. Covered by `node:test` cases now;
if you add a fourth outcome or status value, grep for every `DecisionOutcome`/
`DecisionStatus` switch and widen deliberately, don't let it fall through.

## Data model — everything is derived, nothing is fabricated

There is no `/agents`, `/vendors`, or `/policy` endpoint — the bridge serves exactly
three routes (`/decisions`, `/decisions/:id`, `/simulate`). Every business-facing
view in this redesign (Agent Cards, vendor/category rollups, org policy limits) is
computed client-side from the same `DecisionView[]` window:

- `lib/agents.ts` — per-agent summaries (spend, outcome counts, proof-valid ratio,
  top vendor, cleared categories). Daily totals are **copied verbatim** from the
  most recent decision's `Facts.daily_total_so_far`, never resummed — resumming
  would be a second, drifting copy of a number the kernel already settled.
- `lib/rollups.ts` — vendor / category / daily-spend breakdowns. Vendor `verified`
  and `riskTier` come from the same `Facts`, never guessed for a vendor the window
  hasn't seen (renders `null`, not a fabricated status).
- `lib/identity.ts` — display-name labels only (mirrors the demo seed, humanizes
  unknown ids as a fallback). Carries **no security meaning** — a labeling miss here
  can only make a name look wrong, never change what a decision proved.

Each ships a `node:test` suite (`*.test.ts` beside its source) exercising the "don't
fabricate" invariants directly — e.g. "settledSpend excludes denies and failed
executions," "an agent with no facts has `null` caps, not zero."

## Responsive behavior

- App shell is a sidebar + content grid; below `lg` the sidebar hides and the
  `MobileNav` drawer takes over.
- Data tables (Activity, Vendors) collapse to stacked cards below `md`.
- Dashboard/Agents grids use `grid-cols-1` → `sm:grid-cols-2` → `lg:grid-cols-3/4`
  as appropriate per widget, never a single fixed column count.
- Content is width-capped (`max-w-[1320px]` in-app, `max-w-[1200px]` on the landing
  page) for line length.

## Motion & reduced motion

Compositor-only: bars/gauges animate `transform: scaleX()`/`stroke-dasharray`, never
`width`/layout properties. Buttons press to `scale(0.97)`. Popovers/dialogs scale
from `0.97` + fade, never from `scale(0)`. All animation respects
`prefers-reduced-motion` (see the global rule in `index.css`).

## Accessibility

- Skip-link to `#main`; visible `:focus-visible` rings (`--info`, 2px) on every
  interactive element, including the hand-rolled chart marks.
- Status is never color-only — every chip pairs a dot + color with a text label.
- AA-checked chip/text pairs (`-ink` tokens tuned against `-soft` backgrounds).
- Chart categorical/status colors are colorblind-validated (see Chart tokens above)
  — this is enforced with a script, not eyeballed.

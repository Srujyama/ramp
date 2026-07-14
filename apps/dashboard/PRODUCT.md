# Provable Agent Spend — Product

> **Provable Agent Spend is the trust layer between AI agents and money. Every
> autonomous purchase is policy-controlled, recorded, traceable, and
> independently verifiable.**

This dashboard is the **read-only audit console** for that trust layer. It does
not authorize, block, or move money. It reads the append-only decision log and
lets a human — an auditor, an operator, a reviewer — see exactly what happened on
every autonomous purchase and confirm it independently.

## The problem

When an AI agent can spend money, "trust me" is not an answer. You need to know,
for every purchase: was it allowed by policy? which rules fired? what facts was
the decision made against? can the record be tampered with? did money actually
move? A chat transcript can't answer any of that, and a model's own narration is
not evidence.

## The stance: enforcement is not in the UI

The security boundary lives in two deterministic places, **never** in this
dashboard:

- the **deterministic policy gate** (a policy kernel, not a prompt), and
- the **Claude Code `PreToolUse` hook** that consults it before a payment tool runs.

The dashboard only *shows* what those components already decided and recorded. A
read-only console cannot weaken the guarantee, which is exactly the point: you
could delete this app and the enforcement would be unchanged.

## Audit before execute

The defining property of the lifecycle is that the record is written and
independently re-verified **before** any money moves. The full path a purchase
travels:

```
Agent request
  → Trusted facts loaded        (authoritative ledger + vendor registry)
  → Policy evaluated            (deterministic kernel)
  → Decision produced           (allow / deny)
  → Proof built + persisted     (tamper-evident)
  → Independent re-verification  (recomputed, not trusted from bytes)
  → Payment executed (sandbox) or blocked
  → Receipt recorded
```

The decision and its tamper-evident proof are persisted and re-verified before
the executor is ever called. Audit is not an afterthought printed once the money
is gone — it is a precondition of spending.

## What every decision carries

Each row the console shows is backed by:

- **Policy outcome** — allow or deny (or an error row that is not dressed up as a
  decision).
- **Fired rules** — the exact policy rules that produced that outcome.
- **Trusted facts** — the authoritative facts the kernel evaluated against
  (caps, clearances, approved categories, vendor status), not agent-supplied.
- **Provenance** — a readable, trusted-derived flow of how the decision was
  reached.
- **A tamper-evident proof + independent verification** — recomputed on **every
  read**, never trusted from the stored bytes. Four honest states: `ok` /
  `mismatch` (tampered) / `corrupt` / `absent`.
- **A sandbox execution receipt** (for executed rows) — receiptId, executionId,
  status (`settled` | `failed`), and provider.

## Honesty is a product feature

The console never fabricates. It refuses to overstate what it can prove:

- A **deny** is shown as a deny. An **allowed-but-unexecuted** spend reads "not
  executed", not "settled".
- A **tampered** proof shows ✕. A **corrupt** record is flagged, never hidden.
- KPI tiles render `—` when there is no data — never a fake number.
- A persistent banner makes clear payments are **sandbox** — no real money moves.
- Status is never conveyed by color alone; every chip is paired with text.

## The four-part trust ladder

The heart of the auditor view is a ladder that keeps the claims *separable*, so
each can be believed or disbelieved on its own:

**Decision allowed · Audit persisted · Proof verified · Payment executed**

An allow with an unverified proof is not "green". A verified proof on a denied
spend is not a settlement. Each rung is shown for what it independently is.

## Register

This is **product** software with an **enterprise-infrastructure** aesthetic:
cool blue-slate neutrals, tabular figures, a single reserved verification-green.
It must not read as a generic finance dashboard — the subject is *proof*, not
spend analytics. Design serves the tool; nothing is decorative.

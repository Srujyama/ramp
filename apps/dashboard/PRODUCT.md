# Provable Agent Spend — Product

> **Provable Agent Spend is authorization infrastructure for AI-agent payments.
> Every autonomous purchase decision is policy-controlled, recorded, traceable,
> and independently verifiable.**

Payment platforms prove *who authorized* a payment; this layer proves *the
authorization decision itself was correct given authenticated facts* — and lets
anyone verify that independently. It sits beneath any agentic payment platform
as complementary infrastructure.

This dashboard is the **read-only audit console** for that layer. It does
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
- the fail-closed enforcement point that consults it before a payment tool runs.

The dashboard only *shows* what those components already decided and recorded. A
read-only console cannot weaken the guarantee, which is exactly the point: you
could delete this app and the enforcement would be unchanged. (The UI speaks of
"the policy gate"; the underlying `PreToolUse` hook is an implementation detail
kept out of user-facing chrome.)

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
  → Settlement recorded
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
  read**, never trusted from the stored bytes. Four honest states: `ok`
  (**Proof valid**) / `mismatch` (tampered) / `corrupt` / `absent`.
- **A policy identity** — `policyDigest`, a stable `sha256:…` content digest of
  the org-level policy (per-transaction cap, daily limit, approved categories)
  that judged the request. Two decisions made under the same policy share one
  digest; any policy change moves it. It is an identity, **not** a version number.
- **A sandbox settlement record** (for executed rows) — settlementId,
  executionId, status (`settled` | `failed`), and provider.

## Honesty is a product feature

The console never fabricates. It refuses to overstate what it can prove:

- A **deny** is shown as a deny. An **allowed-but-unexecuted** spend reads "not
  executed", not "settled".
- A **tampered** proof shows ✕. A **corrupt** record is flagged, never hidden.
- KPI tiles render `—` when there is no data — never a fake number.
- A subtle **Demo environment · Sandbox payments** indicator makes clear no real
  money moves (the old full-width banner was retired as visual noise).
- Status is never conveyed by color alone; every chip is paired with text.

### Explanations without an LLM

Every decision carries a **deterministic, plain-English explanation** derived
purely from its recorded state — no model narration, so the same record always
reads the same way. Precedence is fixed: proof integrity (mismatch/corrupt) →
pre-decision error → policy deny (reasons from a fixed rule→phrase map) → allow
(settled / executor-failed / not-executed). For example: *"Denied because the
vendor is not in the approved registry. No payment was executed."*, *"Policy
allowed the purchase, but the payment executor failed. No settlement occurred."*,
or *"The stored proof no longer matches the recorded decision."* The underlying
rule ids stay visible beneath the sentence — the explanation summarizes evidence,
it never replaces it.

## The execution timeline

The heart of the auditor view is a **six-stage execution timeline** that walks
one purchase end to end and keeps every claim *separable*, so each can be believed
or disbelieved on its own:

**Agent request → Trusted facts loaded → Policy evaluated → Decision recorded →
Proof validated → Payment executed / blocked / failed**

Each stage shows its own state, a deterministic explanation, and a copyable
id/timestamp where one exists. The failure modes stay distinct and are never
conflated: a **policy denial** reads *blocked*, a **payment executor failure**
reads *failed*, a **tampered** proof reads failed/tampered, a **malformed** proof
reads *corrupt*, an allowed-but-unexecuted spend reads *skipped*, and an
infrastructure error is a *failed* decision. An allow with an unverified proof is
not "green"; a verified proof on a denied spend is not a settlement. The four
separable claims — *decision allowed · audit persisted · proof verified · payment
executed* — are now expressed as stages of this one timeline rather than a
separate status ladder, with the detailed facts, fired rules, full proof,
provenance, and sandbox settlement record in sections beneath it.

## Recent Activity on the Overview

The Overview surfaces the **five most recent decisions** — each with agent,
vendor, amount, an outcome chip, a proof-state chip, a payment-state chip, a
relative timestamp, and its deterministic explanation — every one linking to its
full detail page. An honest *"Updated Xs ago"* indicator is captured the moment
the fetch resolves, so it never implies data is fresher than it is. Loading,
empty, offline, malformed-response, and bridge-unavailable states all reuse the
same honest state primitives as the rest of the console.

## Policy simulator (read-only preview)

The Policy page carries a **read-only simulator**: enter an agent, vendor,
amount, category, and currency (or prefill one of the seeded example scenarios —
an allow plus one per deny reason — which only ever *prefill*, never auto-run) and
see how the gate *would* decide. The result shows a large **ALLOWED / DENIED**
verdict, the same deterministic explanation used across the console, the fired
rules (human title plus raw rule id), a policy-checks checklist derived from the
resolved facts, the **Policy digest**, and a *"Simulation only — no payment
executed"* label.

Crucially, the simulator **reuses the real policy kernel** — there is no second,
drifting copy of the policy — and it is completely **side-effect free**: it never
writes to the ledger, never builds or persists a proof, and never calls the
payment executor. Its trust boundary is exactly a real decision's — the same
authoritative facts — minus the recording and the money movement.

## Scope, trust boundaries & deferred work

The product theme is deliberately narrow: authorization infrastructure for
AI-agent payments — deterministic authorization kernel → tamper-evident record →
independent verification → gated execution. It intentionally does **not** expand
into generic fintech, spend analytics, accounting, reimbursements, approval
workflows, or real payment rails — those are the product surface of agentic
payment platforms, beneath which this layer sits as complementary decision
verification.

- **Policy denial ≠ payment failure.** A denial means the gate blocked the spend
  and the executor was never called. A payment failure means the gate *allowed*
  the spend but the sandbox executor failed — the decision (and its proof) still
  exist. The console keeps these strictly separate everywhere.
- **Proof valid vs tampered/corrupt.** "Proof valid" means the proof was
  independently recomputed on read and matches the recorded decision. "Tampered"
  means it recomputes to a different id; "corrupt" means the stored proof is
  malformed. None of these are ever shown as a plain "verified".
- **Sandbox.** Every payment is simulated. No real money moves; settlement
  records are demo artifacts.
- **Policy identity, not versioning.** The policy digest is a content identity.
  Historical policy **versioning** — human-readable version numbers, change
  history, diffing two policies over time — is **deferred future work**, not
  faked here.
- **Policy editing is intentionally out of scope.** The simulator is a read-only
  preview; it cannot change policy. Safe policy *editing* requires versioning,
  approvals, rollback, and its own audit trail — none of which exist yet, so
  offering an edit button would be dishonest. Editing is deferred until those
  foundations are built.

## Register

This is **product** software with an **enterprise-infrastructure** aesthetic:
cool blue-slate neutrals, tabular figures, a single reserved verification-green.
It must not read as a generic finance dashboard — the subject is *proof*, not
spend analytics. Design serves the tool; nothing is decorative.

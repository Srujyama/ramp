# `@ramp/provenance` — Pillar 2: the provenance graph

> **Proves the decision at enforce time, not just logs it after.**

## Why an audit log isn't a proof

An audit log says: *the agent paid Acme $340 at 14:02.* That's a claim, **written by the system,
about the system**. To believe it you must already trust the thing you're auditing. That's fine for
SOX — it answers *"what happened?"* — and useless for *"was this decision correct?"*, because a
compromised or buggy gate writes a beautiful log.

A **bundle** is different in kind. It records the decision, the exact **facts** it was computed from,
and for each fact **where that fact came from** — the table, the column, the query, the bound key; or
the notary and statement digest; or the declassifier and its codomain. Then `verifyBundle` lets
anyone **re-run the kernel on those recorded facts** and check the recorded decision falls out.

**The auditor doesn't trust our gate. They redo the arithmetic.**

This only works because the kernel is pure and deterministic — same `Facts`, same `Decision`, no
clock, no I/O, no randomness. Determinism isn't an aesthetic preference here: it's what makes a
decision **reproducible**, and reproducibility is what makes it **provable**. This package is the
cash-out of that design choice.

## What a bundle proves

| # | Check | Catches |
| --- | --- | --- |
| 1 | **Integrity** — `factsDigest` / `bundleDigest` recompute | Facts edited after the decision |
| 2 | **Soundness** — re-derive `kernel.evaluate(facts)` and compare | A decision that *doesn't follow from* its facts |
| 3 | **Completeness** — every field of `Facts` has provenance | An unexplained fact — the hole shaped like an injected one |
| 4 | **Honesty** — provenance value + source category match the facts | A plausible, checkable-looking lie |

Check 2 is the one that matters. **You cannot reseal your way out of arithmetic:** a forger who
understands digests can edit the facts and re-seal so every digest is internally consistent — and
re-derivation catches it anyway. That's why soundness is verified independently of integrity, and
there's a test (`swapping the decision but resealing is still caught`) pinning exactly that.

Check 3 is enforced **mechanically**, against the contract's own `FACT_SOURCES` field list, not by
reviewer diligence. If a value can enter a decision without anyone naming its source, the graph has
a hole exactly the shape of an injected fact.

## What a bundle does NOT prove

**That the ledger itself told the truth.** Nothing downstream can prove that — it's precisely why
`vendor_verified` is backed by pillar 4's cryptography rather than by a database boolean alone.
Provenance makes the chain **visible and checkable end to end**; it does not make its roots honest.

Stating that limit is part of the proof. A pitch about provability that overstates its own proofs
has conceded the argument.

## "Vague" derivations are unrepresentable

*"It came from the ledger"* is a category, and it isn't auditable. *"It is `vendors.verified` where
`vendor_id = 'acme_corp'`, via this exact SQL"* is a claim an auditor can independently go and check.
The `Derivation` union makes the vague version impossible to express:

```ts
type Derivation =
  | { kind: "structured_arg";  field: string }
  | { kind: "sql";             table: string; query: string; params: readonly string[] }
  | { kind: "attestation";     notaryKeyId: string; statementDigest: string; verified: boolean }
  | { kind: "declassified";    contentId: string; declassifier: string; codomain: string; admitted: boolean }
  | { kind: "constant";        note: string }
```

## Rendering is content-free

`renderBundle` produces the decision → facts → sources tree ("this is what you show an auditor").
It records *where* values came from, and for quarantined content **only the digest and codomain,
never the bytes** — an audit view that rendered attacker-authored text to a human reviewer would
reintroduce the injection at the very last step, after all the upstream work to contain it.

## Note on dependencies

`@ramp/provenance` does **not** depend on `@ramp/gate`. The gate is a *consumer* of bundles, and an
auditor brings their own kernel — which is the entire point. The tests use a local mirror kernel for
the same reason.

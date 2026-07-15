# `@ramp/attestation` — Pillar 4: TLSNotary-style invoice attestation

> **Match ≠ authenticate.** A 3-way match checks three documents against *each other*. If all three
> are spoofed together, it passes. This layer asks a different question: did these bytes come from
> the vendor's real domain?

## Scope — read this first

This package is the one most tempting to overstate, so here is the boundary, plainly:

**What it implements.** The *verification half* of an attestation scheme, with real cryptography:

- **Ed25519 signatures** via `node:crypto` — no stubs, no fakes. The tests mint genuine keys and
  attempt genuine forgeries.
- **Canonical, domain-separated encoding** — recursively sorted keys (no signature malleability from
  key reordering) prefixed with `ramp.attestation.v1`, so a signature from another context can't be
  replayed into this one.
- **A notary keyring** — trust is a decision made in advance and out of band, not a computation.
- **Binding checks** against the authoritative vendor registry.

**What it is NOT: the actual TLSNotary protocol.** Real TLSNotary runs a *multi-party computation*
between client and notary, so the notary co-signs a TLS transcript **without** the client ever
holding the session keys alone and **without** the notary seeing the plaintext. We do not implement
the MPC. Here, a notary observes and signs a statement, so you are trusting the notary's honesty
about the session — where real TLSNotary reduces that to a cryptographic guarantee.

The defensible claim this layer actually supports:

> *"These invoice bytes, this amount, and this vendor domain were signed together by a notary we
> already trusted, and none of it has been altered since — and that binding is checked before the
> money moves."*

Strictly stronger than trusting the agent's narration. Strictly weaker than real TLSNotary. Both
halves of that sentence matter — a project whose thesis is provability doesn't get to hand-wave its
own proofs. Swapping in a real TLSNotary verifier means replacing the signature check and the
`transcriptCommitment` semantics; **every binding check below survives unchanged.**

## The two questions

Verification is two independent stages, and it runs them in that order deliberately — we never
reason about the contents of a statement before establishing it's genuine.

**1. Authenticity — is this from a notary we trust?**

The keyring *is* the trust decision. An attacker can mint a mathematically perfect signature with
their own key; it fails because the question is never "is this signed?" but "is this signed by
someone we decided, in advance, to trust?" An empty keyring verifies nothing — correct, fail-closed.

**2. Binding — does this describe *the payment being authorised*?**

Authentic but unbound is worthless: a real attestation for last week's $5 stapler invoice must not
authorise today's $50,000 transfer. So the statement is checked against the world — the ledger's
registered domain and the request's structured args — never against itself.

| Check | Rejection code | Why it exists |
| --- | --- | --- |
| Invoice digest matches the bytes we hold | `invoice_digest_mismatch` | Authentic ≠ relevant. |
| Server domain == the vendor's **registered** domain | `domain_mismatch` | **The spoof beat.** See below. |
| Amount matches the request | `amount_mismatch` | Blocks value swaps under a real signature. |
| Currency matches | `currency_mismatch` | 340 USD ≠ 340 JPY. |
| Notarised within 15 min (60s skew tolerated) | `expired` / `future_dated` | Replay defence. |

### The spoof beat, precisely

An attacker who owns `acme-corp-billing.example` can serve a self-consistent invoice over **genuine
TLS** and have it **genuinely notarised**. Every document agrees with every other document — a 3-way
match passes cleanly. It fails at `domain_mismatch`, because that domain is not what the registry
says Acme *is*. That's the difference between consistency and authenticity, and it's the whole
argument for this pillar.

## The clock is injected — on purpose

`verifyAttestation` takes `now` as a parameter and never reads the clock itself. Freshness genuinely
depends on wall time, so the clock read has to live *somewhere* — it lives at the **caller** (the
hook), out in the fact-gathering layer where reading the world is expected, next to the DB reads.
Only the resulting boolean crosses into the kernel as `attestation_present`.

This keeps two things true at once: `verifyAttestation` is a pure, testable function of its inputs,
and the kernel's *"same Facts → same Decision"* claim survives contact with a freshness check.

## Totality

`verifyAttestation` never throws. Malformed input is a **rejection**, not an exception — it runs on
the enforcement path, where a throw is a denial-of-service seam. The totality test feeds it hostile
and wrong-typed input and asserts a verdict every time.

## The demo notary key is *derived*, not stored

The demo needs a keypair that is **reproducible** (same signatures on every clone; tests don't depend
on fresh entropy) and **obviously not a secret** (fictional org, fake money — you *should* be able to
forge one and watch a binding check reject it).

The first version pasted a PKCS#8 private-key PEM into `notary.ts`. It worked, and it was wrong —
**GitGuardian failed the build over it, correctly.** Two reasons that alarm was right:

1. A committed private-key block trips every secret scanner, forever. Suppressing that alarm teaches
   everyone to click through the next one — including the real one.
2. A PEM is copy-pasteable and has exactly the shape of a production credential, so it invites
   someone to follow the pattern with a real key.

So the key is now **derived from a published constant** (`sha256` of a seed phrase sitting in plain
sight → an Ed25519 seed). Same reproducibility, no credential literal in the repo, and nothing that
can be mistaken for one. The key is worthless **by construction** rather than by policy: you can
regenerate it by reading the file, which is exactly the point.

`productionKeyring()` **refuses to be empty** (a silent empty keyring means every attested payment
fails mysteriously at 3am) and **refuses to trust the demo key id** at all. Real deployments hold the
notary key in an HSM/KMS; the gate only ever needs the **public** half.

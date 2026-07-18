# Hook → ledger wiring (CROSS-OWNER change)

**Status: IMPLEMENTED on branch `neil`.** The wiring below is live in
`.claude/hooks/evaluate.mjs` and its mirror `hook/evaluate.mjs`: the hook calls
`recordDecision()` after kernel eval and before cleanup, persisting allow + deny
(and step-3 fact-source failures as `status:"error"`), each with a `buildProof()`
proof. As of the provenance-capture work, the hook also derives independent
provenance via `buildDecisionProvenance({ request, decision, facts, kernelId })`
and passes the graph into `buildProof`, so live rows persist **non-null**
provenance folded into the proof hash. Both edits are on `neil`'s branch only —
not pushed, not merged. `/.claude/` is `@Srujyama`-owned per CODEOWNERS; these
hook edits were made at the user's explicit direction and remain a cross-owner
change pending `@Srujyama` review. This file is the record of what was applied.

The original apply-ready patch is preserved below for review context.

The hook (`.claude/hooks/evaluate.mjs`, mirrored to `hook/evaluate.mjs`) is the
**only** component that holds the structured request, the authoritative `Facts`,
and the exact `Decision` for both allowed and denied attempts. So it is the only
correct place to call `recordDecision()`. `@ramp/ledger` already provides
everything needed; no frozen shape (`SpendRequest`/`Facts`/`Decision`) changes.

## What to change

The hook already `import`s `@ramp/ledger` (dynamic) and already opens `db`
(`ledger.openLedger()`). Two edits:

### 1. Add one import at the top of the file

```js
import { randomUUID } from "node:crypto";
```
(Or use `globalThis.crypto.randomUUID()` inline — Node 24 has global `crypto` — if
you prefer zero new import lines.)

### 2. Replace the step-4 block (the kernel eval + its `finally` close)

The current `finally` closes `db` immediately after kernel eval, **before** the
decision is persisted or rendered. Persist while `db` is still open, then close.

**Replace this:**

```js
  // ---- 4. evaluate with the deterministic kernel -----------------------
  let decision;
  try {
    if (typeof gate.getKernel !== "function") {
      throw new Error("@ramp/gate.getKernel missing");
    }
    const described = gate.getKernel();
    const kernel = described && described.kernel ? described.kernel : described;
    if (!kernel || typeof kernel.evaluate !== "function") {
      throw new Error("kernel has no evaluate()");
    }
    decision = kernel.evaluate(facts);
  } catch (err) {
    closeQuietly(ledger, db);
    denyAndExit("denied (fail-closed): kernel failed (" + errMsg(err) + ")");
    return;
  } finally {
    closeQuietly(ledger, db);
  }
```

**With this:**

```js
  // ---- 4. evaluate with the deterministic kernel -----------------------
  let decision;
  let kernelId;
  try {
    if (typeof gate.getKernel !== "function") {
      throw new Error("@ramp/gate.getKernel missing");
    }
    const described = gate.getKernel();
    kernelId = described && typeof described.kind === "string" ? described.kind : undefined;
    const kernel = described && described.kernel ? described.kernel : described;
    if (!kernel || typeof kernel.evaluate !== "function") {
      throw new Error("kernel has no evaluate()");
    }
    decision = kernel.evaluate(facts);
  } catch (err) {
    closeQuietly(ledger, db);
    denyAndExit("denied (fail-closed): kernel failed (" + errMsg(err) + ")");
    return;
  }

  // ---- 4b. PERSIST the audit row (allow OR deny) BEFORE enforcing ------
  //   The hook is the only holder of exact facts+decision, so it is the writer.
  //   A fresh hook-minted UUID is the stable correlation id (no native tool_use_id
  //   exists, and no frozen shape carries one). recordDecision stores facts +
  //   decision verbatim and derives status from the decision — it never recomputes
  //   policy or fabricates a rule.
  //   FAIL-CLOSED: if the audit write throws, we DENY (an un-auditable allow is not
  //   a provable allow). This is an infrastructure deny — the reason says so and NO
  //   fired rule is fabricated, so it is never mislabeled as a policy deny.
  try {
    if (typeof ledger.recordDecision === "function" && decision && typeof decision === "object") {
      ledger.recordDecision(db, {
        decisionId: randomUUID(),
        request: req,
        facts,
        decision,
        kernelId,
      });
    }
  } catch (err) {
    closeQuietly(ledger, db);
    denyAndExit("denied (fail-closed): could not persist audit record (" + errMsg(err) + ")");
    return;
  } finally {
    closeQuietly(ledger, db);
  }
```

Everything after (`// ---- 5. render the decision`) is unchanged: it still emits
the same `permissionDecision: "allow"|"deny"` payload and exit code. Persisting
before rendering means **both** allows and denies are logged, and a logging
failure fails closed instead of silently allowing an unaudited spend.

## Failure semantics (summary)

| Path | Behavior |
|------|----------|
| allow + audit OK | allow emitted, row `status=allowed` |
| deny + audit OK | deny emitted, row `status=denied`, fired rules in order |
| allow/deny + audit **throws** (DB error) | **DENY** (fail-closed), reason "could not persist audit record", **no fabricated rule** |
| re-delivery, identical content | idempotent no-op (`inserted:false`); no error |
| re-delivery, different content (retry with changed facts) | `DecisionConflictError` → fail-closed deny (surfaced, never overwritten) |

## Optional addendum — record the earlier fail-closed paths as `status:"error"`

Steps 1–3 (malformed stdin, not-a-SpendRequest, unreachable fact source) currently
`denyAndExit` without a row. The **facts-unavailable** catch (step 3) has both `req`
and an open `db`, so it *can* honestly log an infra error before denying:

```js
    // inside the step-3 catch, BEFORE closeQuietly/denyAndExit:
    try {
      if (db && typeof ledger.recordDecision === "function") {
        ledger.recordDecision(db, { decisionId: randomUUID(), request: req, status: "error", kernelId });
      }
    } catch { /* best-effort; the deny below still fails closed */ }
```

`recordDecision` supports `status:"error"` with no `decision` — an honest audit row
for an infrastructure failure, **not** one of the five policy deny rules. Steps 1–2
have no valid `SpendRequest`/open `db`, so they are intentionally not logged
(logging a row we cannot honestly populate would be worse than none).

## Why the MCP request id is NOT used here

There is no native `tool_use_id` shared between the hook and the MCP tool, and the
MCP's `req_<uuid>` is minted only when the tool *executes* — after a hook allow, and
never for a denied attempt. It cannot correlate hook decisions. The hook-minted
`decisionId` is the authoritative correlation id. The MCP id stays an
execution-scoped settlement id (minted on the payments MCP executor path),
explicitly documented as *not* a policy-correlation id.

---

# The self-enforcing MCP tool and the hook (agent-integration update)

**Status: NO hook change required.** As of the agent-integration work, the
payments MCP `pay_vendor` tool is **self-enforcing**: it drives the shared
purchase lifecycle `requestPurchase()` (exported from `@ramp/ledger`, see
`packages/ledger/src/purchase.ts`) which evaluates policy with the SAME
`@ramp/gate` kernel, builds provenance + a tamper-evident proof, persists the
decision, **independently re-verifies** the proof, and only then executes payment
through an injected sandbox executor. This is the enforcement path for **all** MCP
clients (Claude Code, Codex, Cursor) — it does not depend on any hook.

## Authenticated agent identity at both gates

As of the agent-identity work, both gates verify **who is asking** before any
policy evaluation is trusted: a `SpendRequest` carries an Ed25519 `identity`
signature over its canonical core, and the hook **and** the self-enforcing MCP
tool each verify it against the ledger's **agent registry** (authoritative
public keys, active/revoked status). The result enters the kernel as the
authenticated fact `agent_identity_verified`; the kernel denies unauthenticated
or impersonated requests via `deny/unauthenticated_agent`. Because both gates
verify independently, neither path can be used to dodge authentication.

## This is NOT a second policy path

`requestPurchase()` does not contain policy logic; it calls the injected
`PolicyKernel` (`getKernel().kernel`) and the existing `@ramp/ledger` proof /
provenance / `recordDecision` APIs — the same primitives the hook uses. The hook
and the tool therefore share the policy *kernel* and the ledger *contracts*; only
the thin sequencing differs.

## Relationship under Claude Code (defense in depth, NOT correlated)

Under Claude Code the existing PreToolUse hook still fires first and independently
denies/persists a decision **before** the tool runs. So an allowed spend under
Claude Code produces **two independent audit rows**: the hook's (random `decisionId`)
and the tool's (`requestPurchase`'s content-derived `decisionId`). They are **not**
correlated by any shared native id — do not claim end-to-end hook↔tool correlation.
This is deliberate defense in depth: even if the hook is bypassed, the tool still
fails closed; even if the tool were reverted, the hook still gates. Codex/Cursor
have no hook, so the tool is their sole enforcement + audit path.

## OPTIONAL future unification (cross-owner, NOT applied)

To collapse Claude Code to a single audit row, the hook (`@Srujyama`-owned) could
delegate its gate-only evaluation to a shared helper rather than re-running the
sequence inline. This is **not** required for correctness and is **not** applied.
Because the hook is a *gate* (it cannot execute payment — Claude Code runs the tool
afterward), any unification would keep the hook's role as "evaluate + persist +
allow/deny" and leave execution to the tool. Left as a documented future option for
`@Srujyama` to weigh; the current two-path design is correct and fail-closed.

## Recommended cross-owner comment fix (NOT applied)

The hook's **behavior** is correct and unchanged, but its header comment is now
stale. `hook/evaluate.mjs:5-6` and its mirror `.claude/hooks/evaluate.mjs:5-6`
still read *"This is the ONLY enforcement point. The MCP payments tool is an
honest, non-enforcing stub."* Since the MCP tool is now self-enforcing, the
accurate wording is: *"This hook is an independent, fail-closed pre-gate. The MCP
`pay_vendor` tool is ALSO self-enforcing (via `@ramp/ledger` `requestPurchase`);
the two are independent gates over the same kernel and are not correlated by a
shared id."* These files are `@Srujyama`-owned (`.claude/` + repo root per
CODEOWNERS), so this is a **comment-only** change delivered here for review — not
applied on this branch.

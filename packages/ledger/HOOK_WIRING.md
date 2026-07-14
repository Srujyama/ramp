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
execution-scoped receipt id (see `apps/payments-mcp/src/receipt.ts`), explicitly
documented as *not* a policy-correlation id.

# The Gate — PreToolUse hook

`evaluate.mjs` is the **single enforcement point** for Provable Agent Spend. It
runs as a Claude Code `PreToolUse` hook matching `mcp__payments__.*` and decides
`allow` / `deny` **before** the payments MCP tool is permitted to run. The MCP
tool itself is an honest, non-enforcing stub — it never decides policy.

> Wiring lives in [`.claude/settings.json`](../.claude/settings.json). The
> committed entrypoint the harness invokes is `$CLAUDE_PROJECT_DIR/.claude/hooks/evaluate.mjs`;
> this `hook/evaluate.mjs` is the canonical source for that gate (symlink or copy
> it into `.claude/hooks/` when deploying). Both paths hold the identical
> fail-closed logic.

## Fail-CLOSED by design (crux #1)

The security property is: **a spend is allowed only if the kernel proved it, and
every other outcome denies.** Concretely, `evaluate.mjs` funnels *every* failure
path — malformed stdin, a `tool_input` that is not a `SpendRequest`, an
unreachable ledger, a kernel that throws, a missing import — into a single
`denyAndExit()` that:

1. writes a `hookSpecificOutput` with `permissionDecision: "deny"`, and
2. calls `process.exit(2)` (never `0`).

There is no code path that lets a spend through on error. An `allow` is emitted
only after the deterministic kernel returns `decision === "allow"`; even an
unexpected non-`allow` decision shape denies.

## Command hook, not HTTP (why)

A **command** hook fails closed: if the process errors or exits non-zero, the
tool call is blocked. It also survives `--dangerously-skip-permissions`, unlike
a permission prompt. An HTTP hook could fail *open* (a dropped request or a
timeout might not block the call), which is unacceptable for a payment gate.

## The fact-source trust boundary (crux #2)

The hook uses the request's `vendorId`, `amount`, `category`, `requestingAgent`
**only as keys**. The security-critical facts —
`vendor_verified`, `daily_total_so_far`, `per_txn_cap`, `daily_limit`,
`approved_categories`, `agent_cleared_categories` — are read from the
**authoritative** `@ramp/ledger` fact source (the SQLite ledger + vendor
registry), never from the model's free-text narration. Same authoritative facts
→ same deterministic decision, every time.

## Pipeline

```
stdin (hook JSON)
  → JSON.parse                                   (bad → deny, exit 2)
  → @ramp/shared isSpendRequest(tool_input)      (bad → deny, exit 2)
  → @ramp/ledger openLedger + LedgerFactSource   (unreachable → deny, exit 2)
  → @ramp/shared translateToFacts(req, source)   → Facts (authoritative only)
  → @ramp/gate getKernel().kernel.evaluate       (throws → deny, exit 2)
  → decision "allow" → allow;  anything else     → deny
```

No external npm dependencies — only the `@ramp/*` workspace packages.

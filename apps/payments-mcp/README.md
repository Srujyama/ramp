# @ramp/payments-mcp — stub payments MCP server

A tiny [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
one tool, **`pay_vendor`** (full MCP name **`mcp__payments__pay_vendor`**), over
stdio. An agent calls it to "pay a vendor"; it returns a deterministic fake receipt.

> **This is a stub.** No money moves, and **this server does not enforce policy** — it
> never calls the policy kernel. Enforcement lives entirely in the Claude Code
> **PreToolUse hook** (`.claude/hooks/evaluate.mjs`), which matches `mcp__payments__.*`,
> pulls authoritative facts from `@ramp/ledger`, runs the gate kernel, and can **deny**
> the request *before this tool ever runs*. If the tool executes, the hook already
> allowed it, so the tool just mints a receipt.

## Tool: `pay_vendor`

Input schema mirrors `SpendRequest` from `@ramp/shared`:

| field             | type              | notes                                   |
| ----------------- | ----------------- | --------------------------------------- |
| `vendorId`        | `string`          | vendor to pay, e.g. `"acme_corp"`       |
| `amount`          | `number`          | whole currency units (non-negative int) |
| `currency`        | `string`          | ISO 4217, e.g. `"USD"`                  |
| `category`        | `string`          | spend category, e.g. `"office_supplies"`|
| `invoiceRef`      | `string` (opt)    | invoice/attestation reference           |
| `requestingAgent` | `string`          | agent id, e.g. `"agent_47"`             |

Returns a fake receipt: `{ receiptId, requestId, status: "submitted", vendorId, amount,
currency, category, requestingAgent, invoiceRef?, note }`. The `receiptId` is
**deterministic** — an FNV-1a hash of the request fields joined with a `\0` (NUL)
delimiter so adjacent fields can't alias (no `Math.random`, no clock), so identical
requests yield identical ids.

The `requestId` (e.g. `"req_<uuid>"`) is an **execution-scoped** id: it is minted only
when the tool actually **executes** and is unique per execution. It is **NOT a
policy-correlation id** — the PreToolUse hook decides allow/deny **before** this tool
runs, never sees this id, and there is no native `tool_use_id` shared between the hook
and the tool. **Denied** attempts never execute, so they have no `requestId` at all.
Treat it purely as a per-execution marker on the receipt.

## Build & run

```bash
# from the repo root
pnpm --filter @ramp/payments-mcp build      # tsc -> dist/
pnpm --filter @ramp/payments-mcp start      # node dist/server.js  (stdio)

# or run the TypeScript directly during development
pnpm dlx tsx apps/payments-mcp/src/server.ts
```

The server speaks JSON-RPC on **stdout/stdin**; diagnostics go to **stderr** so they
never corrupt the protocol stream.

## Register in Claude Code

Add it as an stdio MCP server. Either via the CLI:

```bash
claude mcp add payments -- node /absolute/path/to/ramp/apps/payments-mcp/dist/server.js
```

…or by hand in your MCP config (e.g. `~/.claude.json` or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "payments": {
      "command": "node",
      "args": ["/absolute/path/to/ramp/apps/payments-mcp/dist/server.js"]
    }
  }
}
```

The tool then appears to the agent as **`mcp__payments__pay_vendor`**.

### The hook is what actually gates it

The repo's `.claude/settings.json` wires a **PreToolUse** command hook matching
`mcp__payments__.*`. When the agent calls `pay_vendor`, Claude Code runs
`.claude/hooks/evaluate.mjs` **first**. That hook is **fail-closed**: on any bad
input, unreachable DB, or kernel error it denies and exits non-zero. Only if the hook
allows the request does this stub server run and return its fake receipt. Keeping
enforcement in the hook (not the tool) is deliberate: a command hook fails closed even
under `--dangerously-skip-permissions`, whereas trusting the tool would let a
compromised or bypassed server pay anyone.

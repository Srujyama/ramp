# Claude Code — register the payments MCP server

The payments MCP server is a plain **stdio** server. Register it in Claude Code and it
appears to the agent as **`mcp__payments__pay_vendor`**.

> Replace `/ABSOLUTE/PATH/TO/ramp` with the real absolute path to your checkout. Build
> first (`pnpm -r build`) so `dist/server.js` exists.

## Option A — `claude mcp add`

```bash
claude mcp add payments -- node /ABSOLUTE/PATH/TO/ramp/apps/payments-mcp/dist/server.js
```

## Option B — by hand

Add an entry under `mcpServers` in your MCP config (`~/.claude.json`, or a project
`.mcp.json`):

```json
{
  "mcpServers": {
    "payments": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/ramp/apps/payments-mcp/dist/server.js"],
      "env": {}
    }
  }
}
```

No credentials are needed — the executor is a sandbox. Optional env vars
(`RAMP_KERNEL`, `RAMP_DB_PATH`) may be added to the `env` object; see the app README.

## Working directory / shared ledger

The server writes decisions to `ramp.db`, resolved relative to its working directory
(default `ramp.db`). For the read-only bridge and the `verify-proof` CLI to see the
same decisions, point them at the same file — run them from the repo root, or set
`RAMP_DB_PATH` to one absolute path for the server, the bridge, and the CLI.

## Defense in depth: the PreToolUse hook is separate

This repo also ships a Claude Code **`PreToolUse` hook** (`.claude/hooks/evaluate.mjs`,
wired in `.claude/settings.json`) that matches `mcp__payments__.*` and **independently**
evaluates the same request, fail-closed, **before** the tool runs. The hook and this
enforcing tool are **two independent audit layers** — there is no shared native id
correlating them. Both must agree for a spend to go through; either one can deny.

# Cursor — register the payments MCP server

Cursor reads MCP servers from `~/.cursor/mcp.json` (global) or a project-local
`.cursor/mcp.json`. The payments server is a stdio server launched with `node`.

> Replace `/ABSOLUTE/PATH/TO/ramp` with the real absolute path to your checkout. Build
> first (`pnpm -r build`) so `dist/server.js` exists.

## `~/.cursor/mcp.json` (or project `.cursor/mcp.json`)

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
(`RAMP_KERNEL`, `RAMP_DB_PATH`) go in the `env` object; see the app README. After
saving, enable the `payments` server in Cursor's MCP settings; the tool appears as
`mcp__payments__pay_vendor`.

## Shared ledger

For the read-only bridge and `verify-proof` CLI to see the server's decisions, all
three must read the same `ramp.db` — run from the repo root or set `RAMP_DB_PATH` to
one absolute path everywhere.

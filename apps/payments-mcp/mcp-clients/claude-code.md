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

The server **honors `RAMP_DB_PATH`** (in the config `env` object): set it to one
absolute path and the server, the read-only bridge, and the `verify-proof` CLI all
read/write the same ledger — so a payment made through the tool shows up in the
bridge and the dashboard. Unset, the server writes `ramp.db` relative to its working
directory. To demo the executor-failure path, add `RAMP_FAIL_VENDORS=<vendorId>` to
`env` (the sandbox then returns a failed settlement record for those vendors; no real
provider, no secret).

## Defense in depth: the PreToolUse hook is separate

This repo also ships a Claude Code **`PreToolUse` hook** (`.claude/hooks/evaluate.mjs`,
wired in `.claude/settings.json`) that matches `mcp__payments__.*` and **independently**
evaluates the same request, fail-closed, **before** the tool runs. Both gates also
independently verify the request's Ed25519 **agent-identity signature** against the
ledger's agent registry — an unauthenticated or impersonated request is denied on
either path. The hook and this enforcing tool are **two independent audit layers** —
there is no shared native id correlating them. Both must agree for a spend to go
through; either one can deny.

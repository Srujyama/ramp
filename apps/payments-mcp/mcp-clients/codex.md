# Codex — register the payments MCP server

Codex reads MCP servers from its config file (`~/.codex/config.toml`). The payments
server is a stdio server launched with `node`.

> Replace `/ABSOLUTE/PATH/TO/ramp` with the real absolute path to your checkout. Build
> first (`pnpm -r build`) so `dist/server.js` exists.

## `~/.codex/config.toml`

```toml
[mcp_servers.payments]
command = "node"
args = ["/ABSOLUTE/PATH/TO/ramp/apps/payments-mcp/dist/server.js"]
# env = { RAMP_DB_PATH = "/ABSOLUTE/PATH/TO/ramp/ramp.db" }   # optional; no secrets
```

If your Codex build uses JSON rather than TOML, the equivalent stdio entry is:

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

No credentials are needed — the executor is a sandbox. The tool is exposed as
`mcp__payments__pay_vendor`. Optional env vars are `RAMP_KERNEL` (set to `wasm` to opt
into the wasm kernel) and `RAMP_DB_PATH` (shared ledger path). See the app README.

## Shared ledger

For the read-only bridge and `verify-proof` CLI to see the server's decisions, all
three must read the same `ramp.db` — run from the repo root or set `RAMP_DB_PATH` to
one absolute path everywhere.

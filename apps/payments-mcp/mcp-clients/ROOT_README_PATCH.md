# ROOT README patch — enforcing MCP integration

**CROSS-OWNER — apply-ready, NOT applied.**

The root `README.md` is owned by the coordinator. This is a ready-to-paste snippet
announcing that the payments MCP server is now an **enforcing** agent integration (it
was previously described as a non-enforcing stub). Paste it into the root `README.md`
under an appropriate heading (e.g. after the project overview / architecture section).

---

<!-- BEGIN paste -->

## Enforcing payments MCP server

The payments MCP server (`apps/payments-mcp`) is now an **enforcing** agent
integration, not a stub. An agent calls one tool, **`mcp__payments__pay_vendor`**, to
**request** a purchase; the server runs the full provable-spend lifecycle before any
payment is attempted:

Ed25519 agent-identity verification (against the ledger's **agent registry** → the
authenticated fact `agent_identity_verified`) → authorization decision (`@ramp/gate`,
over **authenticated** ledger facts) → derived provenance → tamper-evident proof →
persist → **independent re-verification** → sandbox execution **only** if allowed,
persisted, and verified → structured settlement record or denial.

The lifecycle is **fail-closed**: any failure to gather facts, decide policy, build
provenance/proof, persist, or re-verify results in **no execution**, as does any
denial. The executor is a **sandbox** — no real money moves and no payment provider is
configured.

Works with **Claude Code, Codex, and Cursor** (same stdio server; client-specific
config only). Under Claude Code the existing `PreToolUse` hook remains a **separate,
independent** enforcement layer (defense in depth — the two are not correlated by a
shared native id).

See [`apps/payments-mcp/README.md`](apps/payments-mcp/README.md) and
[`apps/payments-mcp/mcp-clients/`](apps/payments-mcp/mcp-clients/) for setup, the
`pay_vendor` response schemas, and a demo walkthrough.

<!-- END paste -->

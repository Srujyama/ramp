/**
 * @ramp/payments-mcp — ARCHITECTURE TEST: the agent cannot approve itself
 *
 * The single most important property of the escalation feature is not in any
 * function. It is an ABSENCE: there is no code path from the agent's tools to
 * `resolveEscalation`. The agent can ask for permission and wait for an answer;
 * it cannot give itself one.
 *
 * An absence cannot be unit-tested by calling something. It has to be asserted
 * structurally, or it decays the first time somebody adds a convenient tool at
 * 2am with a reassuring name like `confirm_payment`. A comment saying "don't"
 * is not a control — this file is.
 *
 * If these fail, do not relax them. Escalation that the requester can grant is
 * worse than no escalation at all: it manufactures a documented human-in-the-loop
 * that never had a human in it, and everyone downstream believes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every source file in this app (not tests, not build output). */
function appSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "dist-test" || entry === "node_modules") continue;
      appSources(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Source with comments stripped, so prose about a symbol isn't mistaken for a call. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments
}

const SOURCES = appSources(join(HERE, "..", "src"));

test("the MCP app has sources to check (guard against a vacuous pass)", () => {
  // Without this, a refactor that moved or renamed src/ would make every
  // assertion below pass by scanning nothing at all.
  assert.ok(SOURCES.length >= 2, `expected app sources, found ${SOURCES.length}`);
  assert.ok(
    SOURCES.some((f) => f.endsWith("agent-tools.ts")),
    "agent-tools.ts must be among the scanned sources",
  );
});

test("THE CONTROL: no MCP source imports or calls resolveEscalation", () => {
  // Comments are stripped first — agent-tools.ts deliberately DISCUSSES
  // resolveEscalation to explain why it must never call it, and that prose must
  // not trip the test that enforces the rule.
  for (const file of SOURCES) {
    const src = code(file);
    assert.ok(
      !src.includes("resolveEscalation"),
      `${file} references resolveEscalation in CODE. The agent must never be able ` +
        `to approve its own escalation — approval is the human channel (pnpm approve).`,
    );
  }
});

test("no MCP source writes to decision_approvals", () => {
  for (const file of SOURCES) {
    const src = code(file);
    assert.ok(
      !/INSERT\s+INTO\s+decision_approvals|UPDATE\s+decision_approvals|DELETE\s+FROM\s+decision_approvals/i.test(
        src,
      ),
      `${file} writes to decision_approvals directly, bypassing the human channel.`,
    );
  }
});

test("the agent's tools perform no writes at all", () => {
  // check_budget / preview_payment / check_approval / list_decisions are reads.
  // A write appearing here would mean an agent-callable tool with side effects on
  // the audit trail — which is how a read-only surface stops being one.
  const src = code(join(HERE, "..", "src", "agent-tools.ts"));
  for (const forbidden of [
    "recordDecision",
    "recordExecution",
    "resolveEscalation",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
  ]) {
    assert.ok(
      !src.includes(forbidden),
      `agent-tools.ts contains "${forbidden}" — the agent's tools must be READ-ONLY.`,
    );
  }
});

test("only the human channel can resolve an escalation", () => {
  // Positive half of the same claim: the capability exists, and it lives exactly
  // one place the agent cannot reach — a CLI a person runs.
  const approveCli = readFileSync(join(HERE, "..", "..", "..", "scripts", "approve.mjs"), "utf8");
  assert.ok(
    approveCli.includes("resolveEscalation"),
    "scripts/approve.mjs is the human channel and must be able to resolve escalations",
  );
});

test("the pay_vendor tool cannot be handed an approval", () => {
  // A subtler bypass than a tool: an `approved: true` field on the payment
  // request. The agent asserts it is approved, and a careless handler believes
  // it. Approval must be READ from the ledger, never accepted from the caller —
  // the same rule as every other authoritative fact in this codebase.
  const server = code(join(HERE, "..", "src", "server.ts"));
  for (const forbidden of ["approved:", "approval:", "isApproved:", "humanApproved"]) {
    assert.ok(
      !server.includes(forbidden),
      `server.ts accepts "${forbidden}" from the caller — an agent must never be able ` +
        `to ASSERT that it was approved. The verdict is read from the ledger.`,
    );
  }
});

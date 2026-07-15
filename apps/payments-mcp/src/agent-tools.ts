/**
 * @ramp/payments-mcp — the agent's READ-ONLY tools
 *
 * ============================================================================
 * EVERY TOOL HERE IS READ-ONLY. THAT IS THE DESIGN, NOT A LIMITATION.
 * ============================================================================
 * These are the tools an agent gets so it can reason about policy BEFORE trying
 * to spend: how much room is left, what would happen, did a human answer yet.
 *
 * There is deliberately NO tool that approves an escalation. If the agent could
 * approve, the agent that wanted the money would ask for permission, grant
 * itself permission, and proceed — and the audit trail would show a beautifully
 * documented human-in-the-loop that never had a human in it. That is strictly
 * worse than no escalation at all, because it manufactures evidence of a control
 * that does not exist.
 *
 * Approval lives on a different channel entirely: `pnpm approve`, a person at a
 * terminal. The separation IS the control. It is not enforced by a tool
 * description asking the model nicely — the model is free to ignore prose. It is
 * enforced by there being no code path from this file to
 * `resolveEscalation`. If you are about to add one: don't.
 *
 * `check_approval` below tells the agent whether a human has answered. That is
 * the correct amount of power: it can WAIT for a decision, it cannot MAKE one.
 */
import { z } from "zod";
import {
  simulate,
  approvalFor,
  listDecisions,
  LedgerFactSource,
  type LedgerDb,
} from "@ramp/ledger";
import { getKernel } from "@ramp/gate";

/** A single MCP text-content block. */
interface TextContent {
  readonly type: "text";
  readonly text: string;
}

interface ToolResult {
  readonly [key: string]: unknown;
  readonly isError?: boolean;
  readonly content: TextContent[];
  readonly structuredContent: Record<string, unknown>;
}

const ok = (structured: Record<string, unknown>, text: string): ToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
});

// ---------------------------------------------------------------------------
// check_budget — "how much room do I have?"
// ---------------------------------------------------------------------------

export const checkBudgetShape = {
  requestingAgent: z.string().describe('Agent id, e.g. "agent_47".'),
} as const;

/**
 * Report an agent's remaining headroom against the org limits.
 *
 * Exists so an agent can plan instead of guess. Without it the only way to learn
 * "am I over my limit?" is to attempt a payment and be denied — which works, but
 * turns every budget question into an audit-trail entry for a payment nobody
 * intended to make, and trains the agent to probe the gate rather than reason
 * about it.
 *
 * Read-only: pure SELECTs, no decision recorded, nothing to execute.
 */
export function handleCheckBudget(
  args: { requestingAgent: string },
  db: LedgerDb,
): ToolResult {
  const fs = new LedgerFactSource(db);
  let spent: number;
  try {
    spent = fs.getDailyTotalSoFar(args.requestingAgent);
  } catch {
    // An unknown agent throws (fail-closed, by design in the DAL). Report it as
    // a structured answer rather than an error: "I don't know you" is a useful
    // and complete reply to "what is my budget?".
    return {
      isError: true,
      content: [
        { type: "text", text: `Unknown agent "${args.requestingAgent}" — no budget exists.` },
      ],
      structuredContent: { agent: args.requestingAgent, known: false },
    };
  }

  const limits = fs.getLimits();
  const remaining = Math.max(0, limits.dailyLimit - spent);
  const cleared = fs.getAgentClearances(args.requestingAgent);

  return ok(
    {
      agent: args.requestingAgent,
      known: true,
      spentToday: spent,
      dailyLimit: limits.dailyLimit,
      remainingToday: remaining,
      perTxnCap: limits.perTxnCap,
      escalationThreshold: limits.escalationThreshold,
      currency: limits.currency,
      clearedCategories: cleared,
      // The most useful number: the biggest spend that goes through unattended.
      // min(cap, threshold, remaining) — anything larger either denies or needs
      // a human, and an agent that knows this can plan instead of probe.
      maxUnattendedNow: Math.max(
        0,
        Math.min(limits.perTxnCap, limits.escalationThreshold, remaining),
      ),
    },
    `${args.requestingAgent}: spent ${spent}/${limits.dailyLimit} ${limits.currency} today. ` +
      `Up to ${Math.max(0, Math.min(limits.perTxnCap, limits.escalationThreshold, remaining))} ` +
      `settles unattended; above ${limits.escalationThreshold} needs a human; above ` +
      `${limits.perTxnCap} is refused outright.`,
  );
}

// ---------------------------------------------------------------------------
// preview_payment — "what WOULD policy say?"
// ---------------------------------------------------------------------------

export const previewPaymentShape = {
  requestingAgent: z.string().describe('Agent id, e.g. "agent_47".'),
  vendorId: z.string().describe('Vendor id, e.g. "acme_corp".'),
  amount: z.number().int().nonnegative().describe("Amount in whole currency units."),
  category: z.string().describe('Spend category, e.g. "office_supplies".'),
} as const;

/**
 * Preview the policy outcome without spending anything.
 *
 * Runs the REAL kernel through the real fact translator, so the preview cannot
 * disagree with the gate — there is no second policy path here. It is
 * side-effect free: no decision recorded, no proof, no execution.
 *
 * It reports its own premise. A preview has no invoice, so it cannot have a
 * verified attestation, so a truthful evaluation would ALWAYS return
 * "deny: no verified attestation" — technically correct and completely useless,
 * drowning out the question actually asked. `simulate` assumes attestation and
 * says so via `assumedAttested`; that assumption is surfaced here rather than
 * buried, so an agent can never read a preview as a promise.
 */
export function handlePreviewPayment(
  args: { requestingAgent: string; vendorId: string; amount: number; category: string },
  db: LedgerDb,
): ToolResult {
  let result;
  try {
    result = simulate(
      db,
      {
        agent: args.requestingAgent,
        vendor: args.vendorId,
        amount: args.amount,
        category: args.category,
      },
      getKernel().kernel,
    );
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Cannot preview: ${(err as Error).message}` }],
      structuredContent: { preview: false },
    };
  }

  const verdict = result.outcome;
  const human =
    verdict === "allow"
      ? "would settle unattended"
      : verdict === "escalate"
        ? "would be HELD for a human to approve"
        : "would be REFUSED";

  return ok(
    {
      preview: true,
      simulationOnly: true,
      outcome: verdict,
      firedRules: result.firedRules,
      reasons: result.reasons,
      assumedAttested: result.assumedAttested,
      currency: result.currency,
    },
    `PREVIEW (nothing was spent): ${args.amount} ${result.currency} to ${args.vendorId} ` +
      `${human}. Rules: ${result.firedRules.join(", ") || "none"}.` +
      (result.assumedAttested
        ? " Assumes a valid attestation — a real payment without one is refused."
        : ""),
  );
}

// ---------------------------------------------------------------------------
// check_approval — "has a human answered yet?"  (READ, never WRITE)
// ---------------------------------------------------------------------------

export const checkApprovalShape = {
  decisionId: z.string().describe("The decision id returned when the payment was held."),
} as const;

/**
 * Report whether a human has resolved an escalation.
 *
 * THE AGENT CAN WAIT FOR AN ANSWER. IT CANNOT MAKE ONE. This tool reads
 * `decision_approvals`; nothing here writes to it, and there is no tool that
 * does. Approving is `pnpm approve` — a person at a terminal.
 *
 * `approvalFor` returns null if the decision's facts changed since the approval
 * was granted, so an agent cannot get a $1 escalation approved and then report
 * itself approved for $50,000: the binding is checked on every read.
 */
export function handleCheckApproval(args: { decisionId: string }, db: LedgerDb): ToolResult {
  const approval = approvalFor(db, args.decisionId);

  if (!approval) {
    return ok(
      { decisionId: args.decisionId, resolved: false, payable: false },
      `Decision ${args.decisionId} has not been resolved by a human yet. It is HELD. ` +
        `You cannot approve it yourself — a person must run \`pnpm approve\`.`,
    );
  }

  return ok(
    {
      decisionId: args.decisionId,
      resolved: true,
      verdict: approval.verdict,
      approvedBy: approval.approvedBy,
      resolvedAt: approval.resolvedAt,
      payable: approval.verdict === "approved",
    },
    `Decision ${args.decisionId} was ${approval.verdict} by ${approval.approvedBy} ` +
      `at ${approval.resolvedAt}.`,
  );
}

// ---------------------------------------------------------------------------
// list_decisions — "what have I done?"
// ---------------------------------------------------------------------------

export const listDecisionsShape = {
  limit: z.number().int().positive().max(50).optional().describe("Max rows (default 10)."),
} as const;

/** Recent decisions from the append-only log. Read-only. */
export function handleListDecisions(args: { limit?: number }, db: LedgerDb): ToolResult {
  const { decisions } = listDecisions(db, { limit: args.limit ?? 10 });
  const rows = decisions.map((d) => ({
    decisionId: d.decisionId,
    status: d.status,
    outcome: d.outcome,
    vendorId: d.vendorId,
    amount: d.amount,
    ts: d.ts,
  }));
  return ok(
    { count: rows.length, decisions: rows },
    rows.length === 0
      ? "No decisions recorded yet."
      : rows
          .map((r) => `${r.ts}  ${String(r.status).padEnd(9)} ${r.amount} -> ${r.vendorId}`)
          .join("\n"),
  );
}

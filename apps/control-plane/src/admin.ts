/**
 * @ramp/control-plane — typed admin writes (create agent, retune policy dials)
 *
 * ============================================================================
 * ADMINISTERS INPUTS. NEVER DECIDES, NEVER WRITES A DECISION.
 * ============================================================================
 * The dashboard's admin surface lets a demo operator provision the *inputs* a
 * decision is computed from — register an agent + its category clearances, or
 * nudge the org policy dials. This module validates the untrusted request body
 * and hands it to the ledger's sanctioned INPUT-table writers (`createAgent`,
 * `updatePolicyDials`). Those helpers write `agents` / `agent_category_clearances`
 * / `policy_limits` ONLY and reject anything a later decision couldn't stand on
 * (a duplicate agent, an unknown category, a non-integer dial).
 *
 * The point of the demo: change a dial here, then run the SAME transaction on the
 * Simulate panel and watch the gate decide differently — because the kernel reads
 * these inputs. The edit changes the NEXT decision; it can never rewrite one
 * already sealed in the append-only log.
 */
import { createAgent, updatePolicyDials, readDials, type LedgerDb, type CreatedAgent, type Dials, type DialPatch } from "@ramp/ledger";

/** Parse an untrusted create-agent body. Shape only — the DAL enforces the rest. */
export function parseNewAgent(
  body: unknown,
): { agentId: string; displayName: string; clearedCategories: string[] } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.agentId !== "string" || b.agentId.trim() === "") return { error: "agentId is required" };
  if (typeof b.displayName !== "string" || b.displayName.trim() === "") return { error: "displayName is required" };
  const cats = b.clearedCategories ?? [];
  if (!Array.isArray(cats) || !cats.every((c) => typeof c === "string")) {
    return { error: "clearedCategories must be an array of category id strings" };
  }
  return { agentId: b.agentId.trim(), displayName: b.displayName.trim(), clearedCategories: cats as string[] };
}

/** Register an agent + clearances via the ledger's INPUT-table writer. */
export function runCreateAgent(db: LedgerDb, body: unknown): CreatedAgent | { error: string } {
  const parsed = parseNewAgent(body);
  if ("error" in parsed) return parsed;
  try {
    return createAgent(db, parsed);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The dial keys a demo operator may retune (a strict subset of policy_limits). */
const DIAL_KEYS: ReadonlyArray<keyof DialPatch> = ["perTxnCap", "dailyLimit", "escalationThreshold", "velocityLimit"];

/** Parse an untrusted dial patch. Only recognised numeric keys survive. */
export function parseDialPatch(body: unknown): DialPatch | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const patch: { -readonly [K in keyof DialPatch]: DialPatch[K] } = {};
  for (const key of DIAL_KEYS) {
    const v = b[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number") return { error: `${key} must be a number` };
    patch[key] = v;
  }
  if (Object.keys(patch).length === 0) {
    return { error: `provide at least one dial to change: ${DIAL_KEYS.join(", ")}` };
  }
  return patch;
}

/** Apply a dial patch via the ledger's INPUT-table writer; returns the new dials. */
export function runUpdateDials(db: LedgerDb, body: unknown): Dials | { error: string } {
  const parsed = parseDialPatch(body);
  if ("error" in parsed) return parsed;
  try {
    return updatePolicyDials(db, parsed);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Current dials + approved categories — what the admin UI needs to render a form. */
export function adminState(db: LedgerDb): { dials: Dials; categories: string[] } {
  const rows = db.prepare("SELECT category_id FROM categories WHERE approved = 1 ORDER BY category_id").all() as Array<{
    category_id: string;
  }>;
  return { dials: readDials(db), categories: rows.map((r) => r.category_id) };
}

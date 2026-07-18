/**
 * @ramp/ledger — TYPED ADMIN WRITES to INPUT tables (the demo control plane's
 * only mutation surface).
 *
 * ============================================================================
 * WHAT MAY BE WRITTEN HERE, AND WHAT MAY NEVER BE
 * ============================================================================
 * These helpers let the DEMO control plane provision the *inputs* a decision is
 * computed from — register an agent and its category clearances, adjust the org
 * policy dials — so a live demo can reconfigure policy without hand-editing SQL.
 * They are the ONLY sanctioned writers of these input tables from outside the
 * purchase lifecycle. Their constitution:
 *
 *   1. INPUT tables ONLY: `agents`, `agent_category_clearances`, `policy_limits`.
 *      NEVER `decisions`, `decision_provenance`, `ledger_entries`, or any proof/
 *      chain table. A decision is DERIVED from these inputs by the kernel; it is
 *      never authored. Editing a dial changes what the *next* decision will be —
 *      it cannot rewrite a decision already sealed in the append-only log.
 *   2. INTEGER money only, in whole units, within the kernel's i32 range — the
 *      same invariant the gate enforces (`deny/malformed_facts`). A dial that
 *      couldn't be represented as a Soufflé `number` is rejected here, loudly,
 *      rather than silently poisoning a later decision.
 *   3. Every write is a single transaction and validates referential integrity
 *      up front (a clearance for a category that doesn't exist is refused with a
 *      clear message, not an opaque FK error).
 *
 * None of this is on the enforcement path. The hook and kernel never call these;
 * they read the tables these helpers write, exactly as they read a seeded DB.
 */
import type { LedgerDb } from "./db.js";

/** Kernel arithmetic is i32 (Soufflé `number`). Dials must fit, like every fact. */
const INT_MAX = 2_147_483_647;

/** A whole, non-negative integer that fits the kernel's i32 range, or a reason. */
function checkAmount(name: string, v: number): string | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return `${name} must be a whole number (money is integer units)`;
  if (v < 0) return `${name} must not be negative`;
  if (v > INT_MAX) return `${name} must be ≤ ${INT_MAX} (the kernel's integer range)`;
  return null;
}

// --- create an agent (+ its category clearances) -----------------------------

export interface NewAgent {
  readonly agentId: string;
  readonly displayName: string;
  /** Category ids this agent may spend in. Each must already exist in `categories`. */
  readonly clearedCategories: readonly string[];
}

export interface CreatedAgent {
  readonly agentId: string;
  readonly displayName: string;
  readonly clearedCategories: readonly string[];
}

/**
 * Register a new agent and grant its category clearances, atomically. Refuses a
 * duplicate agent id and any clearance for a category that isn't in the approved
 * `categories` registry — so the write can never leave dangling references the
 * kernel would later read. Writes `agents` + `agent_category_clearances` ONLY.
 */
export function createAgent(db: LedgerDb, input: NewAgent): CreatedAgent {
  const agentId = input.agentId?.trim();
  const displayName = input.displayName?.trim();
  if (!agentId) throw new Error("agentId is required");
  if (!displayName) throw new Error("displayName is required");
  if (!Array.isArray(input.clearedCategories)) throw new Error("clearedCategories must be an array");

  // Normalise + de-dupe the requested clearances.
  const categories = [...new Set(input.clearedCategories.map((c) => String(c).trim()).filter(Boolean))];

  const exists = db.prepare("SELECT 1 AS ok FROM agents WHERE agent_id = ?").get(agentId) as { ok?: number } | undefined;
  if (exists) throw new Error(`agent "${agentId}" already exists`);

  // Referential integrity up front: every clearance must name a real category.
  for (const cat of categories) {
    const ok = db.prepare("SELECT 1 AS ok FROM categories WHERE category_id = ?").get(cat) as { ok?: number } | undefined;
    if (!ok) throw new Error(`category "${cat}" does not exist — cannot clear an agent for an unknown category`);
  }

  const insertAgent = db.prepare("INSERT INTO agents (agent_id, display_name) VALUES (?, ?)");
  const insertClearance = db.prepare(
    "INSERT OR IGNORE INTO agent_category_clearances (agent_id, category_id) VALUES (?, ?)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    insertAgent.run(agentId, displayName);
    for (const cat of categories) insertClearance.run(agentId, cat);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* best effort */
    }
    throw err;
  }

  return { agentId, displayName, clearedCategories: categories };
}

// --- edit the org policy dials (the single-row `policy_limits`) ----------------

/** The subset of policy dials the demo admin may retune. All optional; integer. */
export interface DialPatch {
  readonly perTxnCap?: number;
  readonly dailyLimit?: number;
  readonly escalationThreshold?: number;
  readonly velocityLimit?: number;
}

export interface Dials {
  readonly perTxnCap: number;
  readonly dailyLimit: number;
  readonly escalationThreshold: number;
  readonly velocityLimit: number;
  readonly velocityWindowMinutes: number;
  readonly dedupWindowMinutes: number;
  readonly currency: string;
}

/** Column <- patch-key map, in the fixed order we build the UPDATE from. */
const DIAL_COLUMNS: ReadonlyArray<readonly [keyof DialPatch, string, string]> = [
  ["perTxnCap", "per_txn_cap", "per-transaction cap"],
  ["dailyLimit", "daily_limit", "daily limit"],
  ["escalationThreshold", "escalation_threshold", "escalation threshold"],
  ["velocityLimit", "velocity_limit", "velocity limit"],
];

/** Read the current dials back in the same shape `getLimits` exposes. */
export function readDials(db: LedgerDb): Dials {
  const row = db
    .prepare(
      "SELECT per_txn_cap, daily_limit, escalation_threshold, velocity_limit, velocity_window_minutes, dedup_window_minutes, currency FROM policy_limits WHERE id = 1",
    )
    .get() as
    | {
        per_txn_cap: number;
        daily_limit: number;
        escalation_threshold: number;
        velocity_limit: number;
        velocity_window_minutes: number;
        dedup_window_minutes: number;
        currency: string;
      }
    | undefined;
  if (!row) throw new Error("policy_limits row (id=1) missing — DB is not provisioned");
  return {
    perTxnCap: Number(row.per_txn_cap),
    dailyLimit: Number(row.daily_limit),
    escalationThreshold: Number(row.escalation_threshold),
    velocityLimit: Number(row.velocity_limit),
    velocityWindowMinutes: Number(row.velocity_window_minutes),
    dedupWindowMinutes: Number(row.dedup_window_minutes),
    currency: row.currency,
  };
}

/**
 * Retune the org policy dials. Only the keys present in `patch` are changed; each
 * is validated as whole, non-negative, in-range money. Writes the single-row
 * `policy_limits` table ONLY and returns the resulting dials. A no-op patch (no
 * recognised keys) is refused so the caller can't silently change nothing.
 */
export function updatePolicyDials(db: LedgerDb, patch: DialPatch): Dials {
  const sets: string[] = [];
  const values: number[] = [];
  for (const [key, column, label] of DIAL_COLUMNS) {
    const v = patch[key];
    if (v === undefined) continue;
    const bad = checkAmount(label, v);
    if (bad) throw new Error(bad);
    sets.push(`${column} = ?`);
    values.push(v);
  }
  if (sets.length === 0) throw new Error("no recognised dial to update (perTxnCap, dailyLimit, escalationThreshold, velocityLimit)");

  const existing = db.prepare("SELECT 1 AS ok FROM policy_limits WHERE id = 1").get() as { ok?: number } | undefined;
  if (!existing) throw new Error("policy_limits row (id=1) missing — DB is not provisioned");

  db.prepare(`UPDATE policy_limits SET ${sets.join(", ")} WHERE id = 1`).run(...values);
  return readDials(db);
}

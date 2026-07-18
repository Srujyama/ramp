/**
 * @ramp/ledger — synthetic decision history for the demo dashboard
 *
 * DEMO-ONLY. Never on the enforcement path — nothing here is called by the
 * PreToolUse hook or `requestPurchase`. This is the importable core of the
 * `scripts/seed-history.mjs` CLI tool (which is now a thin wrapper around
 * {@link seedDemoHistory}), so the demo control plane's "Enable Dummy Data"
 * toggle can drive the exact same generator in-process against its already-open
 * `db` handle.
 *
 * WHAT IS AND IS NOT REAL HERE
 * ----------------------------
 * The *requests* are synthetic. Every *decision* is not: each one is produced by
 * the real kernel (`referenceKernel.evaluate`) from the facts stored alongside it,
 * sealed with a real `buildProof` + `buildDecisionProvenance`, and appended through
 * the real `recordDecision`. So the console's re-derive button re-runs the kernel on
 * these rows and agrees, and every proof independently verifies (this module
 * asserts that before returning). We fabricate the INPUTS, never the verdicts.
 *
 * WHY THIS DOES NOT DISTURB THE DEMO — THE INVARIANT THAT MATTERS
 * --------------------------------------------------------------
 * Spend is read from `ledger_entries` (src/dal.ts LEDGER_QUERIES) by summing today's
 * rows for an agent / category / vendor. A settled execution AUTOMATICALLY projects
 * one such row (recordExecution). The demo's calibrated prior spend (agent_47: 600
 * office_supplies + 540 software = 1140) is seeded as DIRECT `ledger_entries` rows
 * dated today by the base seed (req_seed_01/02), NOT as settled decisions, and every
 * beat's arithmetic depends on those exact totals — see the headroom rule below.
 *
 * See the full design rationale (headroom rule, category ceilings, idempotency
 * discipline, business-hours arrival curve, per-agent personas) inline below; it is
 * unchanged from the original one-shot script, just re-homed as a callable function.
 *
 * RE-ENTRANCY. Every RNG stream is created FRESH inside {@link seedDemoHistory} (not
 * at module scope), so each call is self-contained and idempotent on its own — a
 * long-lived process (the control plane) can call it more than once without a
 * carried-over PRNG state silently desynchronising a later call from a fresh
 * process's output. `record()`'s own idempotency (stable ids, content-digest
 * conflict detection) still holds within any single call.
 */
import { buildProof } from "./proof.js";
import { buildDecisionProvenance } from "./provenance-builder.js";
import { policyDigest } from "./policy-digest.js";
import { recordDecision, recordExecution } from "./decision-log.js";
import { verifyDecisionProof } from "./proof-verification.js";
import { verifyChain, chainHead } from "./chain.js";
import type { LedgerDb } from "./db.js";
import { referenceKernel } from "@ramp/gate";
import type { Facts, Decision, SpendRequest } from "@ramp/shared";

/** Days of backfilled history, ending YESTERDAY. Today is handled separately. */
const DAYS = 90;
const KERNEL_ID = "ts-reference";

// Policy constants the facts are built against. These MIRROR sql/seed.sql
// (policy_limits) — the historical rows must be judged by the same policy the
// console shows, or the re-derive button disagrees with the log it is reading.
const PER_TXN_CAP = 500;
const DAILY_LIMIT = 1500;
const ESCALATION_THRESHOLD = 400;
// Velocity + duplicate escalation (policy.dl E3/E4) landed on main after this
// seeder was written. History carries recent_txn_count 0 and duplicate_recent_count
// 0 so those rules never fire retroactively. VELOCITY mirrors
// policy_limits.velocity_limit in sql/seed.sql.
const VELOCITY_LIMIT = 6;
const APPROVED_CATEGORIES = ["office_supplies", "software", "travel"];
const ALL_CATEGORIES = [...APPROVED_CATEGORIES, "crypto"];

// --- TODAY's headroom rule (see the module header for the arithmetic) ---

/** The calibrated agent. Its 1140 is what every beat is measured against, so this
 *  generator settles nothing for it — not "little", none. */
const CALIBRATED_AGENT = "agent_47";
/** What that agent's derived total today must still be when this generator exits. */
const CALIBRATED_TOTAL = 1140;

/** Settled spend this generator may ADD today per category, on top of the base seed. */
const TODAY_HEADROOM: Record<string, number> = {
  office_supplies: 120,
  software: 200,
  travel: 900,
  crypto: 0,
};

/** The only vendors carrying a `vendor_daily` budget; today's settles route around them. */
const VENDOR_BUDGETED = new Set(["acme_corp", "newco_ltd"]);

/** Ceilings on TODAY's ORG-WIDE settled total per category — base seed plus this run. */
const CATEGORY_CEILING_TODAY: Record<string, number> = {
  office_supplies: 720,
  software: 740,
  travel: 900,
  crypto: 0,
};

/** Share of settled attempts where policy allowed and the RAIL failed. Real. */
const EXECUTION_FAILURE_RATE = 0.03;
/** Share of requests arriving without an attestation -> deny/attestation_invalid. */
const ATTESTATION_PRESENT_RATE = 0.975;
/** Share of requests for a category the agent is NOT cleared for. */
const STRAY_CATEGORY_RATE = 0.05;

// ---------------------------------------------------------------------------
// Randomness (pure — no db, no I/O)
// ---------------------------------------------------------------------------

type Rand = () => number;

/** Deterministic PRNG (mulberry32) — same seed, same rows, so a fresh call is stable. */
function rng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stateless hash-to-unit-interval, used for calendar-scale features (travel
 * trips) that must NOT consume the `rand` stream — trip windows are decided by
 * looking BACKWARD from each day and cannot depend on how many days the loop spans.
 */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Knuth's method. Request arrivals are counts of independent events — Poisson is the shape. */
function poisson(rand: Rand, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

interface WeightedRow {
  id: string;
  weight: number;
}

function weighted(rand: Rand, rows: readonly WeightedRow[]): WeightedRow {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let n = rand() * total;
  for (const r of rows) {
    n -= r.weight;
    if (n <= 0) return r;
  }
  return rows[rows.length - 1]!;
}

/** SQLite datetime format — "YYYY-MM-DD HH:MM:SS", NOT ISO-8601. */
const sqliteTs = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

// ---------------------------------------------------------------------------
// Vendors — ids from the seed registry (sql/seed.sql), frequencies per persona
// ---------------------------------------------------------------------------
const VENDORS: Record<string, { verified: boolean; tier: "trusted" | "standard" | "elevated" }> = {
  acme_corp: { verified: true, tier: "trusted" },
  globex_inc: { verified: true, tier: "trusted" },
  initech: { verified: true, tier: "standard" },
  newco_ltd: { verified: true, tier: "elevated" },
  sketchy_llc: { verified: false, tier: "standard" },
  unknown_labs: { verified: false, tier: "standard" },
};

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------
interface Calendar {
  isMonthEnd: boolean;
  isMonthStart: boolean;
  isQuarterEnd: boolean;
  travelTrip: boolean;
  engRamp: boolean;
}

interface Persona {
  displayName: string;
  clearances: string[];
  weekdayRate: number;
  weekendRate: number;
  categoryMix: WeightedRow[];
  vendorMix: WeightedRow[];
  /** [weight, lo, hi] */
  amountBands: Array<[number, number, number]>;
  burst: (cal: Calendar) => number;
}

const AGENTS: Record<string, Persona> = {
  agent_47: {
    displayName: "Procurement Agent 47",
    clearances: ["office_supplies", "software"],
    weekdayRate: 4.6,
    weekendRate: 0.3,
    categoryMix: [
      { id: "office_supplies", weight: 68 },
      { id: "software", weight: 32 },
    ],
    vendorMix: [
      { id: "acme_corp", weight: 62 },
      { id: "globex_inc", weight: 22 },
      { id: "initech", weight: 12 },
      { id: "newco_ltd", weight: 2.2 },
      { id: "sketchy_llc", weight: 1.4 },
      { id: "unknown_labs", weight: 0.4 },
    ],
    amountBands: [
      [0.66, 28, 298],
      [0.235, 301, 397],
      [0.065, 403, 496],
      [0.04, 507, 690],
    ],
    burst: (d) => (d.isQuarterEnd ? 2.5 : d.isMonthEnd ? 1.8 : 1),
  },
  agent_12: {
    displayName: "Ops Agent 12",
    clearances: ["office_supplies"],
    weekdayRate: 2.7,
    weekendRate: 0.15,
    categoryMix: [{ id: "office_supplies", weight: 100 }],
    vendorMix: [
      { id: "initech", weight: 44 },
      { id: "globex_inc", weight: 33 },
      { id: "acme_corp", weight: 19 },
      { id: "newco_ltd", weight: 2 },
      { id: "sketchy_llc", weight: 1.6 },
      { id: "unknown_labs", weight: 0.4 },
    ],
    amountBands: [
      [0.78, 11, 134],
      [0.152, 137, 289],
      [0.04, 292, 396],
      [0.022, 404, 487],
      [0.006, 512, 598],
    ],
    burst: (d) => (d.isMonthEnd ? 1.35 : 1),
  },
  agent_23: {
    displayName: "Travel Agent 23",
    clearances: ["office_supplies", "software", "travel"],
    weekdayRate: 1.5,
    weekendRate: 0.45,
    categoryMix: [
      { id: "travel", weight: 82 },
      { id: "office_supplies", weight: 11 },
      { id: "software", weight: 7 },
    ],
    vendorMix: [
      { id: "globex_inc", weight: 51 },
      { id: "initech", weight: 26 },
      { id: "acme_corp", weight: 16 },
      { id: "newco_ltd", weight: 4 },
      { id: "sketchy_llc", weight: 2.2 },
      { id: "unknown_labs", weight: 0.8 },
    ],
    amountBands: [
      [0.4, 23, 118],
      [0.3, 121, 287],
      [0.17, 291, 398],
      [0.09, 402, 498],
      [0.04, 503, 820],
    ],
    burst: (d) => (d.travelTrip ? 3.4 : 1),
  },
  agent_08: {
    displayName: "Eng Tools Agent 08",
    clearances: ["software"],
    weekdayRate: 1.4,
    weekendRate: 0.12,
    categoryMix: [{ id: "software", weight: 100 }],
    vendorMix: [
      { id: "globex_inc", weight: 46 },
      { id: "initech", weight: 31 },
      { id: "acme_corp", weight: 17 },
      { id: "newco_ltd", weight: 3.4 },
      { id: "sketchy_llc", weight: 1.8 },
      { id: "unknown_labs", weight: 0.8 },
    ],
    amountBands: [
      [0.56, 29, 189],
      [0.25, 191, 347],
      [0.11, 351, 398],
      [0.06, 404, 496],
      [0.02, 512, 640],
    ],
    burst: (d) => (d.isMonthStart ? 2.3 : d.engRamp ? 2.1 : 1),
  },
};
const AGENT_IDS = Object.keys(AGENTS);

/** Business-hours arrival curve — two humps, a midday dip, ~2% genuine out-of-hours. */
const HOUR_WEIGHTS = [
  1, 1, 1, 1, 1, 2, 6, 18, 55, 120, 145, 130, 78, 105, 138, 132, 100, 52, 24, 12, 7, 4, 2, 1,
];
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((s, w) => s + w, 0);

function sampleHour(rand: Rand): number {
  let n = rand() * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) {
    n -= HOUR_WEIGHTS[h]!;
    if (n <= 0) return h;
  }
  return 23;
}

function between(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Amounts must not read as a price list. Nudged strictly WITHIN the band. */
function deround(rand: Rand, n: number, lo: number, hi: number): number {
  let x = n;
  for (let guard = 0; guard < 8 && (x % 10 === 0 || x % 25 === 0); guard++) {
    const step = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 3));
    x = Math.min(hi, Math.max(lo, x + step));
  }
  return x;
}

function amountFor(rand: Rand, persona: Persona): number {
  const r = rand();
  let acc = 0;
  for (const [weight, lo, hi] of persona.amountBands) {
    acc += weight;
    if (r <= acc) return deround(rand, between(rand, lo, hi), lo, hi);
  }
  const [, lo, hi] = persona.amountBands[persona.amountBands.length - 1]!;
  return deround(rand, between(rand, lo, hi), lo, hi);
}

/** Agents mostly buy what they are cleared for; a 5% stray exercises the uncleared-category deny. */
function categoryFor(rand: Rand, persona: Persona): string {
  if (rand() >= STRAY_CATEGORY_RATE) return weighted(rand, persona.categoryMix).id;
  const stray = ALL_CATEGORIES.filter((c) => !persona.clearances.includes(c));
  return stray[Math.floor(rand() * stray.length)]!;
}

/** Travel trips: ~4-day clusters, roughly one every two or three weeks. */
function inTravelTrip(dayNum: number): boolean {
  for (let back = 0; back < 4; back++) {
    if (hash01((dayNum - back) * 7919) < 0.085) return true;
  }
  return false;
}

interface SampledEvent {
  at: Date;
  agentId: string;
  vendorId: string;
  category: string;
  amount: number;
  attestationPresent: boolean;
  failExecution: boolean;
  executionDelayMs: number;
}

/**
 * Sample one day's events for one agent. Depends ONLY on the day and the PRNG
 * stream — never on the wall clock, which is what makes a re-run within one call
 * deterministic. Partial days are handled at RECORD time by dropping events that
 * have not happened yet, never at sample time.
 */
function eventsFor(rand: Rand, agentId: string, dayStart: Date, dayIdx: number, calendar: Calendar): SampledEvent[] {
  const persona = AGENTS[agentId]!;
  const isWeekend = [0, 6].includes(dayStart.getUTCDay());
  const base = isWeekend ? persona.weekendRate : persona.weekdayRate;
  // The fleet ramps over the window: an agent estate three months ago was smaller
  // than it is today. A flat volume across the whole window is its own kind of tell.
  const growth = 0.72 + (0.56 * dayIdx) / DAYS;
  const lambda = base * growth * persona.burst(calendar);

  const events: SampledEvent[] = [];
  const n = poisson(rand, lambda);
  for (let i = 0; i < n; i++) {
    const at = new Date(dayStart.getTime());
    at.setUTCHours(sampleHour(rand), between(rand, 0, 59), between(rand, 0, 59), 0);
    const vendorId = weighted(rand, persona.vendorMix).id;
    events.push({
      at,
      agentId,
      vendorId,
      category: categoryFor(rand, persona),
      amount: amountFor(rand, persona),
      attestationPresent: rand() < ATTESTATION_PRESENT_RATE,
      failExecution: rand() < EXECUTION_FAILURE_RATE,
      executionDelayMs: between(rand, 1200, 9000),
    });
  }
  return events;
}

interface OutcomeTally {
  allow: number;
  deny: number;
  escalate: number;
}
function emptyTally(): OutcomeTally {
  return { allow: 0, deny: 0, escalate: 0 };
}

/** Everything {@link seedDemoHistory} measured, for the CLI wrapper's report and any caller. */
export interface DemoSeedResult {
  written: number;
  skipped: number;
  outcome: OutcomeTally;
  byAgent: Record<string, OutcomeTally>;
  byVendor: Record<string, OutcomeTally>;
  byRule: Record<string, number>;
  perDay: Array<{ date: string; count: number; today?: boolean }>;
  settled: number;
  failed: number;
  pending: number;
  todaySettles: number;
  agentSettledToday: Record<string, number>;
  categorySettledToday: Record<string, number>;
  /** Each agent's settled-today baseline BEFORE this run (base seed only). */
  priorSpendSeen: Record<string, number>;
  headroomLeft: Record<string, number>;
  chainHead: string;
  chainLength: number;
  chainValid: boolean;
  chainDefects: unknown;
  badProofs: number;
  proofsChecked: number;
  futureDated: number;
  days: number;
  /** Invariant violations, if any. Empty means every check held. */
  problems: string[];
}

/**
 * Backfill ~3 months of plausible enterprise purchasing traffic (see the module
 * header for the full design rationale) against an already-open, already-provisioned
 * ledger `db`. Idempotent WITHIN one call (deterministic ids); calling it again in
 * the same process re-seeds a fresh PRNG stream, so re-running after
 * {@link clearDemoHistory} produces a fresh, still-realistic, still-real-kernel-derived
 * batch rather than replaying byte-identical content forever.
 */
export function seedDemoHistory(db: LedgerDb): DemoSeedResult {
  const rand = rng(0x5eed47);

  // Register the two agents the base seed does not carry, so the fleet view has more
  // than one card. Additive only — new agents have no seeded spend, so no existing
  // daily total moves.
  for (const id of ["agent_23", "agent_08"]) {
    db.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name) VALUES (?, ?)`).run(
      id,
      AGENTS[id]!.displayName,
    );
    for (const c of AGENTS[id]!.clearances) {
      db.prepare(
        `INSERT OR IGNORE INTO agent_category_clearances (agent_id, category_id) VALUES (?, ?)`,
      ).run(id, c);
    }
  }

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const dayNumOf = (d: Date): number => Math.floor(d.getTime() / 86_400_000);

  const stats = {
    written: 0,
    skipped: 0,
    outcome: emptyTally(),
    byAgent: Object.fromEntries(AGENT_IDS.map((a) => [a, emptyTally()])) as Record<string, OutcomeTally>,
    byVendor: Object.fromEntries(
      Object.keys(VENDORS).map((v) => [v, emptyTally()]),
    ) as Record<string, OutcomeTally>,
    byRule: {} as Record<string, number>,
    perDay: [] as Array<{ date: string; count: number; today?: boolean }>,
    settled: 0,
    failed: 0,
    pending: 0,
  };

  /**
   * Persist one sampled event as a real, kernel-derived, proof-sealed decision.
   *
   * IDEMPOTENCY RULE — every value this closes over must be a function of the
   * SAMPLED EVENT alone, never of what is already in the database. `dailyTotals`
   * advances on the DERIVED decision, not on whether the row was actually inserted,
   * so a partial re-run within one call still produces coherent `daily_total_so_far`
   * facts for the events after it.
   */
  function record(
    ev: SampledEvent,
    idSuffix: string,
    dailyTotals: Record<string, number>,
    allowSettles: boolean,
  ): void {
    const requestId = `inv_h${idSuffix}`;
    const decisionId = `dec_hist_${idSuffix}`;
    const vendor = VENDORS[ev.vendorId]!;
    const persona = AGENTS[ev.agentId]!;

    const request: SpendRequest = {
      vendorId: ev.vendorId,
      amount: ev.amount,
      currency: "USD",
      category: ev.category,
      invoiceRef: requestId,
      requestingAgent: ev.agentId,
    };

    const facts: Facts = {
      request_id: requestId,
      requesting_agent: ev.agentId,
      amount: ev.amount,
      vendor: ev.vendorId,
      category: ev.category,
      vendor_verified: vendor.verified,
      daily_total_so_far: dailyTotals[ev.agentId]!,
      per_txn_cap: PER_TXN_CAP,
      daily_limit: DAILY_LIMIT,
      approved_categories: APPROVED_CATEGORIES,
      agent_cleared_categories: persona.clearances,
      attestation_present: ev.attestationPresent,
      escalation_threshold: ESCALATION_THRESHOLD,
      vendor_risk_tier: vendor.tier,
      // Empty ON PURPOSE — budgets are TODAY-scoped; judging a row dated in the
      // past against today's budget arithmetic would be a limit that did not apply.
      budgets: [],
      recent_txn_count: 0,
      velocity_limit: VELOCITY_LIMIT,
      duplicate_recent_count: 0,
    };

    // The real kernel decides. We never write a verdict we did not derive.
    const decision: Decision = referenceKernel.evaluate(facts);

    const proof = buildProof({
      decisionId,
      request,
      decision,
      facts,
      policyDigest: policyDigest(facts),
      kernelId: KERNEL_ID,
      attestation: { status: ev.attestationPresent ? "present_unverified" : "absent" },
      provenance: buildDecisionProvenance({ request, decision, facts, kernelId: KERNEL_ID }),
      producedAt: ev.at.getTime(),
    });

    const settles = decision.decision === "allow" && allowSettles;
    const status = ev.failExecution ? "failed" : "settled";

    if (settles && status === "settled") dailyTotals[ev.agentId] = dailyTotals[ev.agentId]! + ev.amount;

    const { inserted } = recordDecision(db, {
      decisionId,
      request,
      facts,
      decision,
      kernelId: KERNEL_ID,
      proof,
      ts: sqliteTs(ev.at),
    });
    if (!inserted) {
      stats.skipped++;
      return;
    }

    stats.written++;
    stats.outcome[decision.decision]++;
    stats.byAgent[ev.agentId]![decision.decision]++;
    stats.byVendor[ev.vendorId]![decision.decision]++;
    for (const r of decision.firedRules ?? []) stats.byRule[r] = (stats.byRule[r] ?? 0) + 1;

    if (decision.decision !== "allow") return;

    if (!settles) {
      stats.pending++;
      return;
    }

    recordExecution(db, {
      decisionId,
      receiptId: `rcpt_h${idSuffix}`,
      executionId: `exec_h${idSuffix}`,
      status,
      provider: "sandbox",
      executedAt: sqliteTs(new Date(ev.at.getTime() + ev.executionDelayMs)),
    });

    if (status === "settled") stats.settled++;
    else stats.failed++;
  }

  // -------------------------------------------------------------------------
  // Backfill: DAYS of history, ending YESTERDAY
  // -------------------------------------------------------------------------
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const dayStart = new Date(startOfToday.getTime() - (DAYS - dayIdx) * 86_400_000);
    const dayNum = dayNumOf(dayStart);
    const dom = dayStart.getUTCDate();
    const month = dayStart.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(dayStart.getUTCFullYear(), month + 1, 0)).getUTCDate();

    const calendar: Calendar = {
      isMonthEnd: dom > daysInMonth - 4,
      isMonthStart: dom <= 3,
      isQuarterEnd: dom > daysInMonth - 4 && [2, 5, 8, 11].includes(month),
      travelTrip: inTravelTrip(dayNum),
      engRamp: dayIdx >= 34 && dayIdx <= 55,
    };

    const events: SampledEvent[] = [];
    for (const agentId of AGENT_IDS) {
      events.push(...eventsFor(rand, agentId, dayStart, dayIdx, calendar));
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    const dailyTotals = Object.fromEntries(AGENT_IDS.map((a) => [a, 0]));
    events.forEach((ev, i) => record(ev, `${dayNum}_${i}`, dailyTotals, true));

    stats.perDay.push({ date: sqliteTs(dayStart).slice(0, 10), count: events.length });
  }

  // -------------------------------------------------------------------------
  // TODAY: activity that settles only within measured headroom
  // -------------------------------------------------------------------------
  const SETTLED_TODAY_BASE = `
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM ledger_entries
    WHERE date(ts) = date('now')
      AND agent_id = ?
      AND request_id NOT LIKE 'inv_h%'
  `;
  const todayTotals: Record<string, number> = Object.fromEntries(
    AGENT_IDS.map((a) => [a, Number((db.prepare(SETTLED_TODAY_BASE).get(a) as { total: number } | undefined)?.total ?? 0)]),
  );
  const priorSpendSeen = { ...todayTotals };

  const todayNum = dayNumOf(startOfToday);
  const todayCalendar: Calendar = {
    isMonthEnd: false,
    isMonthStart: startOfToday.getUTCDate() <= 3,
    isQuarterEnd: false,
    travelTrip: inTravelTrip(todayNum),
    engRamp: false,
  };

  const todayEvents: SampledEvent[] = [];
  for (const agentId of AGENT_IDS) {
    todayEvents.push(...eventsFor(rand, agentId, startOfToday, DAYS, todayCalendar));
  }
  todayEvents.sort((a, b) => a.at.getTime() - b.at.getTime());

  const MAX_EXECUTION_DELAY_MS = 9000;

  // Today is a PARTIAL day: compress it onto the hours that have actually elapsed
  // (see the module header — only the PLACEMENT is rescaled, never the set or order).
  const latestAt = now.getTime() - MAX_EXECUTION_DELAY_MS;
  if (todayEvents.length > 0 && todayEvents[todayEvents.length - 1]!.at.getTime() > latestAt) {
    const dayStart = startOfToday.getTime();
    const span = todayEvents[todayEvents.length - 1]!.at.getTime() - dayStart;
    const target = Math.max(0, latestAt - dayStart);
    for (const ev of todayEvents) {
      const frac = span > 0 ? (ev.at.getTime() - dayStart) / span : 0;
      ev.at = new Date(dayStart + Math.floor(frac * target));
    }
  }

  const IN_FLIGHT_MS = 120 * 60 * 1000;
  const headroomLeft: Record<string, number> = { ...TODAY_HEADROOM };

  let todaySettles = 0;
  todayEvents.forEach((ev, i) => {
    const probe = referenceKernel.evaluate({
      request_id: `probe_${i}`,
      requesting_agent: ev.agentId,
      amount: ev.amount,
      vendor: ev.vendorId,
      category: ev.category,
      vendor_verified: VENDORS[ev.vendorId]!.verified,
      daily_total_so_far: todayTotals[ev.agentId]!,
      per_txn_cap: PER_TXN_CAP,
      daily_limit: DAILY_LIMIT,
      approved_categories: APPROVED_CATEGORIES,
      agent_cleared_categories: AGENTS[ev.agentId]!.clearances,
      attestation_present: ev.attestationPresent,
      escalation_threshold: ESCALATION_THRESHOLD,
      vendor_risk_tier: VENDORS[ev.vendorId]!.tier,
      budgets: [],
      recent_txn_count: 0,
      velocity_limit: VELOCITY_LIMIT,
      duplicate_recent_count: 0,
    });

    // THE HEADROOM RULE (module header). All three conditions, or the row does not settle.
    const settles =
      probe.decision === "allow" &&
      ev.agentId !== CALIBRATED_AGENT &&
      !VENDOR_BUDGETED.has(ev.vendorId) &&
      (headroomLeft[ev.category] ?? 0) >= ev.amount;

    if (settles && !ev.failExecution) headroomLeft[ev.category] = headroomLeft[ev.category]! - ev.amount;
    if (settles) todaySettles++;

    const inFlight = ev.at.getTime() >= now.getTime() - IN_FLIGHT_MS;
    if (probe.decision === "allow" && !settles && !inFlight) return;

    record(ev, `${todayNum}_${i}`, todayTotals, /* allowSettles */ settles);
  });
  stats.perDay.push({
    date: sqliteTs(startOfToday).slice(0, 10),
    count: todayEvents.length,
    today: true,
  });

  // -------------------------------------------------------------------------
  // Verify — the whole thesis is provability; hold the generator to the same bar
  // -------------------------------------------------------------------------
  const problems: string[] = [];

  const allRows = db
    .prepare("SELECT decision_id, proof_json FROM decisions d JOIN decision_proofs p USING (decision_id)")
    .all() as Array<{ decision_id: string; proof_json: string }>;
  let badProofs = 0;
  for (const row of allRows) {
    const v = verifyDecisionProof({ proof: JSON.parse(row.proof_json) });
    if (!v.proofVerified) badProofs++;
  }
  if (badProofs > 0) problems.push(`${badProofs} decision(s) have a proof that does not verify`);

  const future = db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE ts > datetime('now')").get() as { n: number };
  if (future.n > 0) problems.push(`${future.n} decision(s) are dated in the future`);

  const SETTLED_TODAY_BY = (column: string): string => `
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM ledger_entries
    WHERE date(ts) = date('now')
      AND ${column} = ?
  `;
  const sumToday = (column: string, key: string): number =>
    Number((db.prepare(SETTLED_TODAY_BY(column)).get(key) as { total: number } | undefined)?.total ?? 0);

  const agentSettledToday: Record<string, number> = Object.fromEntries(AGENT_IDS.map((a) => [a, sumToday("agent_id", a)]));
  const categorySettledToday: Record<string, number> = Object.fromEntries(
    Object.keys(CATEGORY_CEILING_TODAY).map((c) => [c, sumToday("category_id", c)]),
  );

  if (agentSettledToday[CALIBRATED_AGENT] !== CALIBRATED_TOTAL) {
    problems.push(
      `${CALIBRATED_AGENT} settled ${agentSettledToday[CALIBRATED_AGENT]} today, must be exactly ` +
        `${CALIBRATED_TOTAL} — the beats are calibrated against it`,
    );
  }

  for (const [category, ceiling] of Object.entries(CATEGORY_CEILING_TODAY)) {
    if (categorySettledToday[category]! > ceiling) {
      problems.push(
        `${category} settled ${categorySettledToday[category]} today, ceiling ${ceiling} — ` +
          `a demo beat now lands on a different rule`,
      );
    }
  }

  const { head, length } = chainHead(db);
  const chain = verifyChain(db);
  if (!chain.valid) problems.push("hash chain is INVALID");

  return {
    written: stats.written,
    skipped: stats.skipped,
    outcome: stats.outcome,
    byAgent: stats.byAgent,
    byVendor: stats.byVendor,
    byRule: stats.byRule,
    perDay: stats.perDay,
    settled: stats.settled,
    failed: stats.failed,
    pending: stats.pending,
    todaySettles,
    agentSettledToday,
    categorySettledToday,
    priorSpendSeen,
    headroomLeft,
    chainHead: head,
    chainLength: length,
    chainValid: chain.valid,
    chainDefects: chain.defects,
    badProofs,
    proofsChecked: allRows.length,
    futureDated: future.n,
    days: DAYS,
    problems,
  };
}

// ---------------------------------------------------------------------------
// clearDemoHistory
// ---------------------------------------------------------------------------

/**
 * The base seed's `ledger_entries` block, verbatim from sql/seed.sql (the exact
 * text there is the source of truth — this must be kept in lockstep with it, the
 * same discipline the policy constants above already keep with `policy_limits`).
 * Re-run with fresh `datetime('now')`-relative timestamps on every clear, exactly
 * as a real `pnpm db:reset` would produce.
 */
const BASE_LEDGER_ENTRIES_SQL = `
  INSERT INTO ledger_entries (agent_id, vendor_id, category_id, amount, currency, request_id, ts) VALUES
    ('agent_47', 'acme_corp', 'office_supplies', 600, 'USD', 'req_seed_01', datetime('now')),
    ('agent_47', 'acme_corp', 'software',        540, 'USD', 'req_seed_02', datetime('now')),
    ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_01', datetime('now')),
    ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_02', datetime('now')),
    ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_03', datetime('now')),
    ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_04', datetime('now')),
    ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_05', datetime('now')),
    ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_06', datetime('now')),
    ('agent_12', 'acme_corp', 'travel', 850, 'USD', 'req_trav_01', datetime('now', '-12 days')),
    ('agent_12', 'acme_corp', 'travel', 850, 'USD', 'req_trav_02', datetime('now', '-20 days')),
    ('agent_dup', 'acme_corp', 'subscriptions', 120, 'USD', 'req_dup_seed', datetime('now', '-30 minutes'));
`;

/** The demo-only agents {@link seedDemoHistory} registers, cleaned up on clear. */
const DEMO_ONLY_AGENTS = ["agent_23", "agent_08"];

/**
 * Undo {@link seedDemoHistory}: wipe the decision log and its projected spend, and
 * restore the base seed's calibrated `ledger_entries` rows — a clean chain restart,
 * not a surgical delete.
 *
 * WHY A FULL WIPE, NOT A SLICE. `decisions` is hash-chained (`seq`, `prev_chain_hash`,
 * `chain_hash` — see src/chain.ts): deleting only the `dec_hist_*` rows in the middle
 * of the chain would leave every decision after them with a `prev_chain_hash` that no
 * longer resolves, which `verifyChain` would (correctly) report as tampering. This is
 * demo/sandbox data, so a reset-to-base-seed on disable is safe and honest — it is
 * exactly what `pnpm db:reset` already does for the whole database, just scoped to
 * the tables this generator actually touches (never `agents`/`vendors`/`categories`/
 * `policy_limits`/`budgets` beyond the two demo-only agent rows below, since those
 * are config a real Create Agent / policy-dial action may also have touched).
 */
export function clearDemoHistory(db: LedgerDb): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Cascades to decision_fired_rules / decision_proofs / decision_executions /
    // decision_approvals via ON DELETE CASCADE (schema.sql).
    db.exec("DELETE FROM decisions;");
    db.exec("DELETE FROM ledger_entries;");
    db.exec(BASE_LEDGER_ENTRIES_SQL);
    for (const id of DEMO_ONLY_AGENTS) {
      db.prepare("DELETE FROM agent_category_clearances WHERE agent_id = ?").run(id);
      db.prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

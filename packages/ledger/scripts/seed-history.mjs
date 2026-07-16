/**
 * @ramp/ledger — synthetic decision history for the demo dashboard
 *
 * The dashboard derives EVERY figure from the decision log, so a freshly reset DB
 * plus `pnpm demo` yields ~6 decisions on 2 days — a bar chart with two identical
 * bars. This backfills ~3 MONTHS of plausible enterprise purchasing traffic so the
 * console looks like something that has been running for a quarter, not something
 * just switched on.
 *
 * WHAT IS AND IS NOT REAL HERE
 * ----------------------------
 * The *requests* are synthetic. Every *decision* is not: each one is produced by
 * the real kernel (`referenceKernel.evaluate`) from the facts stored alongside it,
 * sealed with a real `buildProof` + `buildDecisionProvenance`, and appended through
 * the real `recordDecision`. So the console's re-derive button re-runs the kernel on
 * these rows and agrees, and every proof independently verifies (this script asserts
 * that before it exits). We fabricate the INPUTS, never the verdicts — which is the
 * whole point of the product. The outcome mix below is therefore not a target we
 * write; it is a result we measure.
 *
 * WHY THIS DOES NOT DISTURB THE DEMO — THE INVARIANT THAT MATTERS
 * --------------------------------------------------------------
 * Spend is read from `ledger_entries` (src/dal.ts LEDGER_QUERIES) by summing today's
 * rows for an agent / category / vendor:
 *
 *     SELECT SUM(amount) FROM ledger_entries WHERE agent_id = ? AND date(ts) = date('now')
 *
 * A settled execution AUTOMATICALLY projects one such row from its decision
 * (recordExecution, src/decision-log.ts), so a settled decision this script records
 * today ALSO writes a `ledger_entries` row — we never insert that table by hand.
 * The demo's calibrated prior spend (agent_47: 600 office_supplies + 540 software =
 * 1140) is seeded as DIRECT `ledger_entries` rows dated today by the base seed
 * (req_seed_01/02), NOT as settled decisions, and every beat's arithmetic depends on
 * those exact totals. Category and vendor budgets are ORG-WIDE — `#spentFor` in
 * src/dal.ts carries no agent filter — so a settled row dated today for ANY agent
 * moves a total some beat is standing on. Past days are never at risk:
 * `date(ts) = date('now')` excludes them tomorrow as surely as it does today.
 *
 * An earlier cut banned settled rows dated today outright. That was stricter than the
 * arithmetic requires, and it showed: three of the four agent cards read "N
 * transactions verified" beside "$0 today", which reads as a broken console rather
 * than a quiet one. The beats do not need today to be EMPTY; they need the shared
 * totals they stand on to stay under their limits. There is real headroom, so today's
 * rows may settle WITHIN IT.
 *
 * THE HEADROOM RULE
 * -----------------
 * agent_47 is the calibrated one and may not move: this script settles NOTHING for it,
 * so its derived total today stays exactly the base seed's 1140.
 *
 * Every OTHER agent settles a given event today when both hold:
 *
 *   1. its category still has headroom (caps below, consumed in time order),
 *   2. its vendor is neither acme_corp nor newco_ltd (the only two with a
 *      vendor_daily budget — today's settles route through globex_inc / initech).
 *
 * Today is a partial day, and its events are COMPRESSED onto the hours that have
 * actually elapsed rather than dropped for sitting in the future — see the note above
 * `latestAt`. Sampling still never reads the clock; only placement does.
 *
 * The caps, and the beat that BINDS each one. Budgets are in sql/seed.sql; "base" is
 * the base seed's contribution, all of it agent_47's:
 *
 *   office_supplies  +120  BINDS: the escalate beat (agent_12, $450 office). Budget
 *                          1200, base 600 => 600+120+450 = 1170 <= 1200, so the beat
 *                          still reaches E1 instead of dying on D7. This is the
 *                          tightest of the three. The hero beat ($340) is looser
 *                          (600+120+340 = 1060), and beat 2 ($400, which must deny on
 *                          daily_limit ALONE) stays quiet at 600+120+400 = 1120.
 *   software         +200  BINDS: the budget beat (agent_47, $300 software). Budget
 *                          800, base 540. The cap is set so the settles are themselves
 *                          legal (540+200 = 740 <= 800) while the beat still DENIES on
 *                          budget_exceeded (740+300 = 1040 > 800).
 *   travel           +900  BINDS: nothing. No beat touches travel and the budget is
 *                          5000 — the roomy one, which is why the travel agent carries
 *                          most of today's visible spend.
 *   crypto             +0  Unapproved (categories.approved=0) AND budgeted at 0; the
 *                          kernel denies it regardless. The 0 is belt to that braces.
 *
 * Vendor budgets exist for acme_corp (2500) and newco_ltd (200) and nothing else.
 * Rather than spend either one's headroom, today's settles AVOID both: globex_inc and
 * initech carry no vendor_daily row, so they cannot move a vendor total any beat
 * reads. Beat 2's acme arithmetic (1140+400 <= 2500) and beat 6b's newco escalation
 * (0+100 <= 200) are therefore untouched by construction rather than by calculation.
 *
 * Anything that does not fit is unchanged: an allowed row still in flight (no
 * execution row) if it landed within IN_FLIGHT_MS, otherwise dropped. Denies and
 * escalations are unaffected — they never settle, so the derivation cannot see them.
 * Every cap above is ASSERTED before exit, not merely intended.
 *
 * Backdated `ts` is safe: the hash chain links on `seq` and `H(prev || proofId ||
 * decisionId)` (src/chain.ts) and never reads `ts`. Rows are appended in ascending
 * date order regardless, and the script verifies the chain before it exits.
 *
 * Idempotent: deterministic ids + a seeded PRNG mean re-running is a no-op rather
 * than a duplicate or a DecisionConflictError. Headroom is consumed from the SAMPLED
 * event list, never from what happened to be inserted — see the idempotency rule on
 * `record()`, which the headroom rule obeys as strictly as the daily totals do.
 *
 *   node packages/ledger/scripts/seed-history.mjs   # or: pnpm --filter @ramp/ledger db:history
 */
import {
  openLedger,
  closeLedger,
  buildProof,
  buildDecisionProvenance,
  policyDigest,
  recordDecision,
  recordExecution,
  verifyDecisionProof,
  verifyChain,
  chainHead,
} from "../dist/src/index.js";
import { referenceKernel } from "@ramp/gate";

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
// 0 so those rules never fire retroactively — the synthetic escalations come from
// elevated-risk vendors and over-threshold amounts, which is realism enough. VELOCITY
// mirrors policy_limits.velocity_limit in sql/seed.sql; a recorded fact must match the
// policy the console shows or the re-derive button disagrees with the log.
const VELOCITY_LIMIT = 6;
const APPROVED_CATEGORIES = ["office_supplies", "software", "travel"];
const ALL_CATEGORIES = [...APPROVED_CATEGORIES, "crypto"];

// --- TODAY's headroom rule (see the header for the arithmetic and the binding beat) ---

/** The calibrated agent. Its 1140 is what every beat is measured against, so this
 *  script settles nothing for it — not "little", none. */
const CALIBRATED_AGENT = "agent_47";
/** What that agent's derived total today must still be when this script exits. */
const CALIBRATED_TOTAL = 1140;

/** Settled spend this script may ADD today per category, on top of the base seed.
 *  A category absent from this map gets no headroom at all — an unknown category
 *  must not read as unlimited, which is the same fail-closed shape src/dal.ts takes
 *  when it meets a budget scope it cannot measure. */
const TODAY_HEADROOM = {
  office_supplies: 120,
  software: 200,
  travel: 900,
  crypto: 0,
};

/** The only vendors carrying a `vendor_daily` budget, and both are load-bearing for a
 *  beat. Today's settles route around them entirely rather than spend their headroom. */
const VENDOR_BUDGETED = new Set(["acme_corp", "newco_ltd"]);

/** Ceilings on TODAY's ORG-WIDE settled total per category — base seed plus this
 *  script. These are the numbers the beats actually stand on, so they are asserted
 *  before exit rather than trusted to the caps above. */
const CATEGORY_CEILING_TODAY = {
  office_supplies: 720, // 600 base + 120. Escalate beat: 720 + 450 = 1170 <= 1200.
  software: 740, //        540 base + 200. Budget beat still denies: 740 + 300 > 800.
  travel: 900, //            0 base + 900. Budget 5000; no beat reads travel.
  crypto: 0, //              Unapproved — must never settle at all.
};

/** Share of settled attempts where policy allowed and the RAIL failed. Real. */
const EXECUTION_FAILURE_RATE = 0.03;
/** Share of requests arriving without an attestation -> deny/attestation_invalid. */
const ATTESTATION_PRESENT_RATE = 0.975;
/** Share of requests for a category the agent is NOT cleared for. See categoryFor(). */
const STRAY_CATEGORY_RATE = 0.05;

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — same run, same rows, so re-running is a no-op. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(0x5eed47);
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/**
 * A stateless hash-to-unit-interval, used for calendar-scale features (travel
 * trips) that must NOT consume the `rand` stream. Trip windows are decided by
 * looking BACKWARD from each day, so they cannot draw from a sequential PRNG
 * without the draw order — and therefore every row after it — depending on how
 * many days the loop happens to span.
 */
function hash01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Knuth's method. Request arrivals are counts of independent events — Poisson is the shape. */
function poisson(lambda) {
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

function weighted(rows) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let n = rand() * total;
  for (const r of rows) {
    n -= r.weight;
    if (n <= 0) return r;
  }
  return rows[rows.length - 1];
}

/** SQLite datetime format — "YYYY-MM-DD HH:MM:SS", NOT ISO-8601. */
const sqliteTs = (d) => d.toISOString().slice(0, 19).replace("T", " ");

// ---------------------------------------------------------------------------
// Vendors — ids from the seed registry (sql/seed.sql), frequencies per persona
// ---------------------------------------------------------------------------
// `newco_ltd` is risk-tier "elevated", so EVERY request to it escalates (policy.dl
// E2) — it stays rare on purpose, or the console reads as one long queue of held
// payments. `sketchy_llc`/`unknown_labs` are unverified, so every request to them
// denies (D1); they are the rare mistake, not a habit.
const VENDORS = {
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
// Each agent is a different job, so each one has a different SHAPE: how often it
// buys, from whom, in what category, for how much. Sampling agent/vendor/category/
// amount independently (the first cut) produced a fleet where the travel agent
// bought software from a stationery supplier and every agent looked identical in
// aggregate — the tell that gives synthetic data away fastest.
//
// `amountBands` are [weight, lo, hi]. The bounds deliberately AVOID the policy
// boundaries (400 / 500), so a band is entirely on one side of a rule and the
// de-rounding nudge below can never move a row across an outcome edge. The bands
// are what make the outcome mix fall out of the facts: the tails over 400 and 500
// are the escalations and cap denials, and nothing asserts them.
const AGENTS = {
  agent_47: {
    displayName: "Procurement Agent 47",
    clearances: ["office_supplies", "software"],
    // The fleet's workhorse: buys every business day, occasionally over a weekend.
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
    // Procurement's calendar: a burst in the last few days of a month, a bigger
    // one at quarter end. This is the single most recognisable pattern in real
    // purchasing data and the cheapest way to stop every bar being the same height.
    burst: (d) => (d.isQuarterEnd ? 2.5 : d.isMonthEnd ? 1.8 : 1),
  },
  agent_12: {
    displayName: "Ops Agent 12",
    clearances: ["office_supplies"],
    // Restocks consumables. Steady, small, boring — and that IS its signature.
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
    // Books trips, so its volume is CLUSTERED, not steady: quiet for a fortnight,
    // then four days of flights, hotels and ground transport. Also the only agent
    // that works weekends with any regularity — travel does not respect Friday.
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
    // Bimodal: incidentals and ground transport, then the bookings themselves.
    // Travel carries the fattest tail over the threshold — a long-haul fare
    // legitimately needs a human, which is exactly what E1 is for.
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
    // Buys seats and renewals. Low steady volume, a spike at month start when
    // subscriptions renew, and one project ramp partway through the window.
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

/**
 * Business-hours arrival curve. Two humps (pre- and post-lunch), a dip at midday,
 * a thin tail into the evening and ~2% genuine out-of-hours. A fixed cadence —
 * or a flat uniform hour — is the second-biggest tell after round numbers.
 */
const HOUR_WEIGHTS = [
  1, 1, 1, 1, 1, 2, 6, 18, 55, 120, 145, 130, 78, 105, 138, 132, 100, 52, 24, 12, 7, 4, 2, 1,
];
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((s, w) => s + w, 0);

function sampleHour() {
  let n = rand() * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) {
    n -= HOUR_WEIGHTS[h];
    if (n <= 0) return h;
  }
  return 23;
}

/**
 * Amounts must not read as a price list. Real invoices are 287 and 1_247, never
 * 100/200/500 — a column of round numbers is the fastest way to out a synthetic
 * dataset. Nudged strictly WITHIN the band so it can never cross a policy edge.
 */
function deround(n, lo, hi) {
  let x = n;
  for (let guard = 0; guard < 8 && (x % 10 === 0 || x % 25 === 0); guard++) {
    const step = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 3));
    x = Math.min(hi, Math.max(lo, x + step));
  }
  return x;
}

function amountFor(persona) {
  const r = rand();
  let acc = 0;
  for (const [weight, lo, hi] of persona.amountBands) {
    acc += weight;
    if (r <= acc) return deround(between(lo, hi), lo, hi);
  }
  const [, lo, hi] = persona.amountBands[persona.amountBands.length - 1];
  return deround(between(lo, hi), lo, hi);
}

/**
 * Agents mostly buy what they are cleared for. The occasional stray is what makes
 * `deny/agent_uncleared_for_category` show up at all — but picking the category
 * independently of the agent (the first cut here) made it the single most common
 * outcome in the whole log, which is not what a working fleet looks like. At 5%,
 * it is a real control catching a real mistake instead of a wall of noise.
 */
function categoryFor(agentId, persona) {
  if (rand() >= STRAY_CATEGORY_RATE) return weighted(persona.categoryMix).id;
  const stray = ALL_CATEGORIES.filter((c) => !persona.clearances.includes(c));
  return stray[Math.floor(rand() * stray.length)];
}

/** Travel trips: ~4-day clusters, roughly one every two or three weeks. */
function inTravelTrip(dayNum) {
  for (let back = 0; back < 4; back++) {
    if (hash01((dayNum - back) * 7919) < 0.085) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Open the ledger and top up the registry
// ---------------------------------------------------------------------------

const db = openLedger(process.env.RAMP_DB_PATH, { provisionIfEmpty: false });

// Register the two agents the base seed does not carry, so the fleet view has more
// than one card. Additive only — new agents have no seeded spend, so no existing
// daily total moves.
for (const id of ["agent_23", "agent_08"]) {
  db.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name) VALUES (?, ?)`).run(
    id,
    AGENTS[id].displayName,
  );
  for (const c of AGENTS[id].clearances) {
    db.prepare(
      `INSERT OR IGNORE INTO agent_category_clearances (agent_id, category_id) VALUES (?, ?)`,
    ).run(id, c);
  }
}

const now = new Date();
const startOfToday = new Date(now);
startOfToday.setUTCHours(0, 0, 0, 0);
/** Absolute day number, so calendar features are stable across runs. */
const dayNumOf = (d) => Math.floor(d.getTime() / 86_400_000);

// ---------------------------------------------------------------------------
// Generate one day's events for one agent (pure sampling — no DB, no kernel)
// ---------------------------------------------------------------------------

/**
 * Sample one day's events for one agent. Depends ONLY on the day and the PRNG
 * stream — never on the wall clock. That is what makes a re-run a no-op: event `i`
 * of a given day always has the same content, so it always hashes into the same
 * `decisionId`. Conditioning today's volume on the current hour (an earlier cut
 * here) broke exactly this: re-running an hour later re-sampled today's events, and
 * the same ids came back carrying different content — a DecisionConflictError, not
 * an idempotent no-op. Partial days are handled at RECORD time by dropping events
 * that have not happened yet, never at sample time.
 */
function eventsFor(agentId, dayStart, dayIdx, calendar) {
  const persona = AGENTS[agentId];
  const isWeekend = [0, 6].includes(dayStart.getUTCDay());
  const base = isWeekend ? persona.weekendRate : persona.weekdayRate;
  // The fleet ramps over the window: an agent estate three months ago was smaller
  // than it is today. A flat 90-day volume is its own kind of tell.
  const growth = 0.72 + (0.56 * dayIdx) / DAYS;
  const lambda = base * growth * persona.burst(calendar);

  const events = [];
  const n = poisson(lambda);
  for (let i = 0; i < n; i++) {
    const at = new Date(dayStart.getTime());
    at.setUTCHours(sampleHour(), between(0, 59), between(0, 59), 0);
    const vendorId = weighted(persona.vendorMix).id;
    events.push({
      at,
      agentId,
      vendorId,
      category: categoryFor(agentId, persona),
      amount: amountFor(persona),
      attestationPresent: rand() < ATTESTATION_PRESENT_RATE,
      failExecution: rand() < EXECUTION_FAILURE_RATE,
      // Sampled HERE, not at record time, even though only allowed rows use it.
      // See the note on `record()`: every draw from the PRNG must happen during
      // sampling, or an idempotent skip desynchronises the stream.
      executionDelayMs: between(1200, 9000),
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Record one event through the REAL kernel + proof + log
// ---------------------------------------------------------------------------

const stats = {
  written: 0,
  skipped: 0,
  outcome: { allow: 0, deny: 0, escalate: 0 },
  byAgent: Object.fromEntries(AGENT_IDS.map((a) => [a, { allow: 0, deny: 0, escalate: 0 }])),
  byVendor: Object.fromEntries(
    Object.keys(VENDORS).map((v) => [v, { allow: 0, deny: 0, escalate: 0 }]),
  ),
  byRule: {},
  perDay: [],
  settled: 0,
  failed: 0,
  pending: 0,
};

/**
 * Persist one sampled event as a real, kernel-derived, proof-sealed decision.
 *
 * IDEMPOTENCY RULE — every value this function derives must be a function of the
 * SAMPLED EVENTS ALONE, never of what is already in the database. Two earlier cuts
 * each broke it and each died the same way, with a DecisionConflictError on day 1
 * of a re-run:
 *
 *   1. The execution delay was drawn from `rand()` HERE, after the `inserted`
 *      check returned early on an already-present row. A skipped row then consumed
 *      one fewer draw than the first run had, so the PRNG stream desynchronised and
 *      every later row re-sampled to different content under the same stable id.
 *      Fix: `record` draws from `rand()` NEVER; `eventsFor` samples every random
 *      field up front.
 *   2. `dailyTotals` only advanced on a successful insert, so on a re-run the
 *      skipped rows left the running total behind and `daily_total_so_far` — a
 *      FACT, folded into the content digest — diverged from run 1.
 *      Fix: the total advances below on the derived decision, not on `inserted`.
 *
 * Both are the same mistake: letting persisted state feed back into generation. The
 * generator must be able to produce byte-identical rows against an empty DB and a
 * full one, or "re-running is a no-op" is not true. Today's headroom rule is the
 * third place this bites and obeys the same discipline: the caller consumes headroom
 * off the sampled event, never off `inserted`, and reads today's baseline from the
 * base seed's rows alone (see `SETTLED_TODAY_BASE`).
 *
 * @param ev            the sampled request
 * @param idSuffix      deterministic id component
 * @param dailyTotals   per-agent settled spend so far on this day (mutated)
 * @param allowSettles  whether an allow may carry an execution. Always true for
 *                      backfilled days; for TODAY the caller decides per event from
 *                      the headroom rule (see header).
 */
function record(ev, idSuffix, dailyTotals, allowSettles) {
  const requestId = `inv_h${idSuffix}`;
  const decisionId = `dec_hist_${idSuffix}`;
  const vendor = VENDORS[ev.vendorId];
  const persona = AGENTS[ev.agentId];

  const request = {
    vendorId: ev.vendorId,
    amount: ev.amount,
    currency: "USD",
    category: ev.category,
    invoiceRef: requestId,
    requestingAgent: ev.agentId,
  };

  const facts = {
    request_id: requestId,
    requesting_agent: ev.agentId,
    amount: ev.amount,
    vendor: ev.vendorId,
    category: ev.category,
    vendor_verified: vendor.verified,
    daily_total_so_far: dailyTotals[ev.agentId],
    per_txn_cap: PER_TXN_CAP,
    daily_limit: DAILY_LIMIT,
    approved_categories: APPROVED_CATEGORIES,
    agent_cleared_categories: persona.clearances,
    attestation_present: ev.attestationPresent,
    escalation_threshold: ESCALATION_THRESHOLD,
    vendor_risk_tier: vendor.tier,
    // Empty ON PURPOSE. Budgets are evaluated per-request from the DB in the real
    // path, and every budget in the seed is TODAY-scoped (category_daily /
    // vendor_daily). Passing today's budget arithmetic to a row dated in April
    // would judge history against a limit that did not apply to it.
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: VELOCITY_LIMIT,
    duplicate_recent_count: 0,
  };

  // The real kernel decides. We never write a verdict we did not derive.
  const decision = referenceKernel.evaluate(facts);

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

  // A small share of allowed payments fail at the executor — policy said yes, the
  // rail said no. The dashboard flags these, which is correct and real.
  const settles = decision.decision === "allow" && allowSettles;
  const status = ev.failExecution ? "failed" : "settled";

  // Advance the running total BEFORE the insert, and off the DERIVED decision
  // rather than off `inserted` — see the idempotency rule above. Only SETTLED money
  // counts against a limit, which is the same claim src/dal.ts makes when it derives
  // spend: a failed payment moved nothing, so it must not move the total.
  if (settles && status === "settled") dailyTotals[ev.agentId] += ev.amount;

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
  stats.byAgent[ev.agentId][decision.decision]++;
  stats.byVendor[ev.vendorId][decision.decision]++;
  for (const r of decision.firedRules ?? []) stats.byRule[r] = (stats.byRule[r] ?? 0) + 1;

  if (decision.decision !== "allow") return;

  if (!settles) {
    // TODAY, and this row did not clear the headroom rule (agent_47, a budgeted
    // vendor, or a category with no room left). Writing no execution row is not a
    // shortcut — it is the only honest way to represent a payment still in flight,
    // and it is what keeps the totals the beats stand on under their limits. See
    // the header.
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

// ---------------------------------------------------------------------------
// Backfill: DAYS of history, ending YESTERDAY
// ---------------------------------------------------------------------------

for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
  // dayIdx 0 is the oldest day; the last iteration lands on YESTERDAY. Ascending
  // order is required — the chain is append-only and must not be built backwards.
  const dayStart = new Date(startOfToday.getTime() - (DAYS - dayIdx) * 86_400_000);
  const dayNum = dayNumOf(dayStart);
  const dom = dayStart.getUTCDate();
  const month = dayStart.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(dayStart.getUTCFullYear(), month + 1, 0)).getUTCDate();

  const calendar = {
    isMonthEnd: dom > daysInMonth - 4,
    isMonthStart: dom <= 3,
    isQuarterEnd: dom > daysInMonth - 4 && [2, 5, 8, 11].includes(month),
    travelTrip: inTravelTrip(dayNum),
    // A tool-adoption ramp: three weeks where eng-tools buys markedly more.
    engRamp: dayIdx >= 34 && dayIdx <= 55,
  };

  const events = [];
  for (const agentId of AGENT_IDS) {
    events.push(...eventsFor(agentId, dayStart, dayIdx, calendar));
  }
  // Chronological within the day, so `daily_total_so_far` tells a coherent story
  // across the day instead of jumping around, and the chain's seq order matches
  // the wall-clock order an auditor would expect.
  events.sort((a, b) => a.at - b.at);

  const dailyTotals = Object.fromEntries(AGENT_IDS.map((a) => [a, 0]));
  events.forEach((ev, i) => record(ev, `${dayNum}_${i}`, dailyTotals, true));

  stats.perDay.push({ date: sqliteTs(dayStart).slice(0, 10), count: events.length });
}

// ---------------------------------------------------------------------------
// TODAY: activity that settles only within measured headroom
// ---------------------------------------------------------------------------
// Today's baseline is whatever the BASE SEED already settled (agent_47's calibrated
// 1140). We READ it rather than assume it, so today's `daily_total_so_far` stays
// coherent with the DB even while another workstream is changing the seed.
//
// SPEND IS `ledger_entries` NOW, not the decision log. A settled execution projects
// a `ledger_entries` row (recordExecution, src/decision-log.ts), and every windowed
// total the kernel reads — daily_total_so_far, velocity, dedup, budgets — sums that
// table (src/dal.ts LEDGER_QUERIES). So the baseline is read from `ledger_entries`,
// and agent_47's calibrated 1140 lives there as the base seed's direct rows
// (req_seed_01/02), never as settled decisions.
//
// `AND request_id NOT LIKE 'inv_h%'` is load-bearing, and it is the idempotency rule
// on `record()` one level up. Now that this script settles rows today, its OWN
// projected `ledger_entries` rows (request_id `inv_h<day>_<i>`, see `record()`) land
// in exactly the total this query measures: run 2 would open agent_12 at run 1's
// closing balance, every later `daily_total_so_far` would shift, and the same
// deterministic ids would come back carrying different facts — a DecisionConflictError,
// not a no-op. Excluding our own `inv_h` prefix leaves the base seed's rows
// (req_seed_*) in and this run's own rows out, making the baseline a function of the
// base seed alone — identical against an empty DB and an already-seeded one.
const SETTLED_TODAY_BASE = `
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM ledger_entries
  WHERE date(ts) = date('now')
    AND agent_id = ?
    AND request_id NOT LIKE 'inv_h%'
`;
const todayTotals = Object.fromEntries(
  AGENT_IDS.map((a) => [a, Number(db.prepare(SETTLED_TODAY_BASE).get(a)?.total ?? 0)]),
);
const priorSpendSeen = { ...todayTotals };

const todayNum = dayNumOf(startOfToday);
const todayCalendar = {
  isMonthEnd: false,
  isMonthStart: startOfToday.getUTCDate() <= 3,
  isQuarterEnd: false,
  travelTrip: inTravelTrip(todayNum),
  engRamp: false,
};

const todayEvents = [];
for (const agentId of AGENT_IDS) {
  todayEvents.push(...eventsFor(agentId, startOfToday, DAYS, todayCalendar));
}
todayEvents.sort((a, b) => a.at - b.at);

/** Longest `executionDelayMs` any event can sample. Reserved at the end of the
 *  window below: a settled execution stamped after `now` is the same lie as a
 *  future-dated decision, and `executedAt` is `at + executionDelayMs`. */
const MAX_EXECUTION_DELAY_MS = 9000;

// ---------------------------------------------------------------------------
// Today is a PARTIAL day: compress it onto the hours that have actually elapsed.
// ---------------------------------------------------------------------------
// `eventsFor` places a day's requests on the business-hours curve (the mass sits
// 09:00-16:00 UTC). For any past day that is exactly right. For TODAY it means that
// before 09:00 nothing has "happened" yet, so every event sorts into the future and
// an earlier cut dropped the lot — the console then showed three of four agents with
// hundreds of verified decisions and $0 of spend today, which reads as broken rather
// than as early.
//
// It is also INCONSISTENT with the base seed, which stamps agent_47's calibrated 1140
// as spent today at whatever hour `db:reset` ran (`priorSpendTimes`, src/db.ts). The
// demo's premise is a day already in progress, and one agent cannot be mid-day while
// the other three are at a hard zero. `seedPriorSpend` resolves this by spreading
// across the elapsed day rather than stamping the future; today's events do the same.
//
// Only the PLACEMENT is rescaled — the SET and the ORDER are untouched. Two properties
// make that safe, and both are load-bearing:
//
//   - Idempotency. The recorded set stops depending on the clock entirely, which is
//     what keeps `daily_total_so_far` — a FACT, folded into `content_digest` —
//     identical across runs. Only `ts` moves with the clock, and `ts` is excluded from
//     `content_digest` (recordDecision, src/decision-log.ts) while the proof's
//     `producedAt` is excluded from `proofId` (VOLATILE_PROOF_FIELDS, src/proof.ts) and
//     `proofId` is what folds into the digest. So a re-run an hour later re-derives
//     byte-identical CONTENT under the same ids: first write wins, keeps its ts, no-op.
//     This is MORE deterministic than dropping, not less.
//   - Shape. The rescale is RELATIVE, and it only fires when the day's last event has
//     not actually elapsed. Spreading the events EVENLY (the obvious cut, and what
//     `priorSpendTimes` does for its four rows) would hand today a fixed ~35-minute
//     cadence — the exact tell HOUR_WEIGHTS exists to avoid, and it would be the one
//     day on the chart that ticks like a metronome. Anchoring at midnight and scaling
//     preserves the curve's humps; once the day has genuinely elapsed this is a no-op
//     and today carries its true sampled hours.
const latestAt = now.getTime() - MAX_EXECUTION_DELAY_MS;
if (todayEvents.length > 0 && todayEvents.at(-1).at.getTime() > latestAt) {
  const dayStart = startOfToday.getTime();
  const span = todayEvents.at(-1).at.getTime() - dayStart;
  const target = Math.max(0, latestAt - dayStart);
  for (const ev of todayEvents) {
    // Monotonic in `at`, so the sorted order above still holds afterwards.
    const frac = span > 0 ? (ev.at.getTime() - dayStart) / span : 0;
    ev.at = new Date(dayStart + Math.floor(frac * target));
  }
}

// An allowed request from earlier today would have settled by now. One that cannot
// settle under the headroom rule is therefore only honest while it is still plausibly
// in flight; older ones are dropped rather than misrepresented as still pending — a
// pile of un-executed allows reads as a stuck executor, which is a different (and
// alarming) claim from the one we mean to make.
const IN_FLIGHT_MS = 120 * 60 * 1000;

/** Headroom left per category for TODAY. Consumed in time order (todayEvents is
 *  sorted), so the same events always claim it in the same order across runs. */
const headroomLeft = { ...TODAY_HEADROOM };

// EVERY sampled event is considered — the compression above already placed them all
// in the past, so there is nothing left to drop for being future-dated and an event's
// id never depends on when the script ran. The "no future-dated rows" invariant is
// asserted globally before exit rather than defended per-event here.
let todaySettles = 0;
todayEvents.forEach((ev, i) => {
  // Probe the kernel BEFORE recording, only to decide whether this row belongs in
  // today at all and whether it may settle. Denies and escalations are always written
  // — they never settle, so the derivation cannot see them and they are safe on any
  // day. The verdict that gets PERSISTED is still the one `record()` derives from the
  // same facts; this probe decides nothing about the decision itself.
  const probe = referenceKernel.evaluate({
    request_id: `probe_${i}`,
    requesting_agent: ev.agentId,
    amount: ev.amount,
    vendor: ev.vendorId,
    category: ev.category,
    vendor_verified: VENDORS[ev.vendorId].verified,
    daily_total_so_far: todayTotals[ev.agentId],
    per_txn_cap: PER_TXN_CAP,
    daily_limit: DAILY_LIMIT,
    approved_categories: APPROVED_CATEGORIES,
    agent_cleared_categories: AGENTS[ev.agentId].clearances,
    attestation_present: ev.attestationPresent,
    escalation_threshold: ESCALATION_THRESHOLD,
    vendor_risk_tier: VENDORS[ev.vendorId].tier,
    budgets: [],
    recent_txn_count: 0,
    velocity_limit: VELOCITY_LIMIT,
    duplicate_recent_count: 0,
  });

  // THE HEADROOM RULE (header). All three conditions, or the row does not settle.
  const settles =
    probe.decision === "allow" &&
    ev.agentId !== CALIBRATED_AGENT &&
    !VENDOR_BUDGETED.has(ev.vendorId) &&
    (headroomLeft[ev.category] ?? 0) >= ev.amount;

  // Consume off the SAMPLED event, never off `inserted` — a re-run skips the insert
  // and must still consume identically, or the headroom left for every later event
  // diverges and stable ids come back with different facts. A FAILED execution moved
  // no money, so it takes no headroom: the same claim `record()` makes when it
  // advances `dailyTotals` only on a settled status, and the same one src/dal.ts
  // makes when it derives spend from settled rows alone.
  if (settles && !ev.failExecution) headroomLeft[ev.category] -= ev.amount;
  if (settles) todaySettles++;

  // A settling row is written whatever its hour — it has an execution, so it is not
  // claiming to be in flight. Only a NON-settling allow has to be recent to be honest.
  const inFlight = ev.at.getTime() >= now.getTime() - IN_FLIGHT_MS;
  if (probe.decision === "allow" && !settles && !inFlight) return;

  record(ev, `${todayNum}_${i}`, todayTotals, /* allowSettles */ settles);
});
stats.perDay.push({
  date: sqliteTs(startOfToday).slice(0, 10),
  count: todayEvents.length,
  today: true,
});

// ---------------------------------------------------------------------------
// Verify — the whole thesis is provability; hold the seed to the same bar
// ---------------------------------------------------------------------------

const problems = [];

// 1. Every proof must independently re-verify. A row whose proof does not
//    recompute is worse than a missing row: it is a false claim of integrity.
const allRows = db
  .prepare("SELECT decision_id, proof_json FROM decisions d JOIN decision_proofs p USING (decision_id)")
  .all();
let badProofs = 0;
for (const row of allRows) {
  const v = verifyDecisionProof({ proof: JSON.parse(row.proof_json) });
  if (v.reason !== "ok") badProofs++;
}
if (badProofs > 0) problems.push(`${badProofs} decision(s) have a proof that does not verify`);

// 2. Never future-dated.
const future = db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE ts > datetime('now')").get();
if (future.n > 0) problems.push(`${future.n} decision(s) are dated in the future`);

// 3. THE demo invariants. Today's ORG-WIDE settled totals are what every beat's
//    arithmetic stands on, so they are measured against the ceilings, not assumed to
//    have landed under them. `ledger_entries` is the source of truth the kernel reads
//    (src/dal.ts), so these sum THAT table. They count EVERY source — the base seed's
//    direct rows AND this script's projected rows — because that is exactly what the
//    kernel will see when a beat runs: the ceiling caps base + this run combined.
const SETTLED_TODAY_BY = (column) => `
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM ledger_entries
  WHERE date(ts) = date('now')
    AND ${column} = ?
`;
const sumToday = (column, key) =>
  Number(db.prepare(SETTLED_TODAY_BY(column)).get(key)?.total ?? 0);

const agentSettledToday = Object.fromEntries(AGENT_IDS.map((a) => [a, sumToday("agent_id", a)]));
const categorySettledToday = Object.fromEntries(
  Object.keys(CATEGORY_CEILING_TODAY).map((c) => [c, sumToday("category_id", c)]),
);

// 3a. The calibrated agent must not have moved AT ALL. Every beat is written against
//     this exact number, so "close" is a failure.
if (agentSettledToday[CALIBRATED_AGENT] !== CALIBRATED_TOTAL) {
  problems.push(
    `${CALIBRATED_AGENT} settled ${agentSettledToday[CALIBRATED_AGENT]} today, must be exactly ` +
      `${CALIBRATED_TOTAL} — the beats are calibrated against it`,
  );
}

// 3b. Every category ceiling. Breaching one does not corrupt the log; it silently
//     re-verdicts a beat, which is worse — the demo would fail somewhere else.
for (const [category, ceiling] of Object.entries(CATEGORY_CEILING_TODAY)) {
  if (categorySettledToday[category] > ceiling) {
    problems.push(
      `${category} settled ${categorySettledToday[category]} today, ceiling ${ceiling} — ` +
        `a demo beat now lands on a different rule`,
    );
  }
}

const { head, length } = chainHead(db);
const chain = verifyChain(db);
if (!chain.valid) problems.push("hash chain is INVALID");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (n, d) => (d === 0 ? "0.0" : ((n / d) * 100).toFixed(1));
const total = stats.outcome.allow + stats.outcome.deny + stats.outcome.escalate;

const past = stats.perDay.filter((d) => !d.today);
const counts = past.map((d) => d.count);
const busiest = past.reduce((a, b) => (b.count > a.count ? b : a), past[0]);

console.log(
  `\nseed-history: wrote ${stats.written} decisions (${stats.skipped} already present) ` +
    `across ${stats.perDay.length} days — ${past[0]?.date} … today\n`,
);

console.log("outcome mix");
for (const k of ["allow", "escalate", "deny"]) {
  console.log(`  ${k.padEnd(9)} ${String(stats.outcome[k]).padStart(5)}  ${pct(stats.outcome[k], total).padStart(5)}%`);
}
console.log(
  `  executions: ${stats.settled} settled, ${stats.failed} failed ` +
    `(${pct(stats.failed, stats.settled + stats.failed)}% of attempts), ${stats.pending} pending (today, in-flight)`,
);

console.log("\nper agent                     allow   held   deny    total");
for (const a of AGENT_IDS) {
  const s = stats.byAgent[a];
  const t = s.allow + s.deny + s.escalate;
  console.log(
    `  ${(AGENTS[a].displayName + ` (${a})`).padEnd(28)}` +
      `${String(s.allow).padStart(5)}${String(s.escalate).padStart(7)}${String(s.deny).padStart(7)}` +
      `${String(t).padStart(9)}  (${pct(s.allow, t)}% allowed)`,
  );
}

console.log("\nper vendor                    allow   held   deny    total");
for (const v of Object.keys(VENDORS)) {
  const s = stats.byVendor[v];
  const t = s.allow + s.deny + s.escalate;
  console.log(
    `  ${(v + ` [${VENDORS[v].verified ? VENDORS[v].tier : "unverified"}]`).padEnd(28)}` +
      `${String(s.allow).padStart(5)}${String(s.escalate).padStart(7)}${String(s.deny).padStart(7)}` +
      `${String(t).padStart(9)}  (${pct(t, total)}% of traffic)`,
  );
}

console.log("\nfired rules");
for (const [r, n] of Object.entries(stats.byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r.padEnd(38)} ${String(n).padStart(5)}`);
}

console.log("\nvolume");
console.log(`  days covered      ${stats.perDay.length} (${DAYS} backfilled + today)`);
console.log(`  per day           min ${Math.min(...counts)}, max ${Math.max(...counts)}, mean ${(counts.reduce((s, c) => s + c, 0) / counts.length).toFixed(1)}`);
console.log(`  busiest day       ${busiest.date} (${busiest.count})`);
console.log(`  today             ${stats.perDay.at(-1).count} sampled, ${stats.pending} allowed-in-flight, ${todaySettles} settled within headroom`);

// What the agent cards actually read. This is the derived total — the same query
// src/dal.ts runs — not a number this script tracked and hoped was right.
console.log("\ntoday's derived spend (what the agent cards show)");
for (const a of AGENT_IDS) {
  const note = a === CALIBRATED_AGENT ? "  calibrated, must not move" : "";
  console.log(
    `  ${(AGENTS[a].displayName + ` (${a})`).padEnd(28)}${String(agentSettledToday[a]).padStart(6)}` +
      `   (baseline ${priorSpendSeen[a]})${note}`,
  );
}

console.log("\ninvariants");
console.log(`  chain             length ${length}, head ${head.slice(0, 20)}…, valid=${chain.valid}`);
console.log(`  proofs verify     ${allRows.length - badProofs}/${allRows.length}`);
console.log(`  future-dated      ${future.n}`);
console.log(
  `  ${CALIBRATED_AGENT} today    ${agentSettledToday[CALIBRATED_AGENT]} (must be exactly ${CALIBRATED_TOTAL})`,
);
for (const [category, ceiling] of Object.entries(CATEGORY_CEILING_TODAY)) {
  const left = headroomLeft[category] ?? 0;
  console.log(
    `  ${category.padEnd(17)} ${String(categorySettledToday[category]).padStart(4)} / ${ceiling} settled today` +
      ` (${left} of ${TODAY_HEADROOM[category]} headroom unused)`,
  );
}
console.log(
  `  today's baseline  ` +
    AGENT_IDS.map((a) => `${a}=${priorSpendSeen[a]}`).join(" ") +
    "  (base seed only, not this script's own rows)",
);

closeLedger(db);

if (problems.length > 0) {
  console.error("\nseed-history FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  if (!chain.valid) console.error("chain defects:", chain.defects);
  process.exit(1);
}
console.log("\nseed-history: OK\n");

-- ============================================================================
-- @ramp/ledger — demo seed (the exact hackathon scenario)
-- ============================================================================
-- Agent: agent_47.  Verified vendor: acme_corp.  Approved category: office_supplies.
-- Policy: per_txn_cap 500, daily_limit 1500.  Prior spend today for agent_47: 1140.
--   => the hero happy-path request (req_9f, 340) ALLOWS: 1140 + 340 = 1480 <= 1500.
--   => a second/over-limit request tips it past 1500 for the deny beat, e.g.
--      any amount >= 361 (<= cap) denies by daily_limit ("... > 1500").
-- The prior total is seeded at 1140 (~$1200) — chosen so every headline figure in
-- the plan holds AND demo beat 1 is a genuine ALLOW (the plan's example reason
-- "1200 + 340 > 1500" describes the OVER-LIMIT beat, not the happy path).
-- ----------------------------------------------------------------------------

-- agent_47 is the hero. agent_12 is REGISTERED but has spent nothing today — it
-- exists so tests can cover "an authoritative zero" separately from "I don't know
-- who this is" (which now throws UnknownAgentError instead of reading as zero).
INSERT INTO agents (agent_id, display_name) VALUES
  ('agent_47', 'Procurement Agent 47'),
  ('agent_12', 'Ops Agent 12'),
  -- A busy automation agent: already at the velocity limit this hour, so its next
  -- payment escalates on rate even though every amount is tiny and within cap.
  ('agent_burst', 'Batch Agent');

-- Vendor registry: one verified vendor + two unverified (for the spoof/deny beats).
INSERT INTO vendors (vendor_id, display_name, verified, registry_domain, registry_verified_at, registry_method, risk_tier) VALUES
  ('acme_corp',    'Acme Corp',    1, 'acme.example.com', '2026-07-01T00:00:00Z', 'tlsnotary', 'trusted'),
  -- Verified, real domain, real attestation — and onboarded yesterday. Exactly
  -- the shape of a supplier-impersonation setup, and the escalate beat: every
  -- check is green and a human still gets asked.
  ('newco_ltd',    'NewCo Ltd',    1, 'newco.example.com', '2026-07-15T00:00:00Z', 'tlsnotary', 'elevated'),
  ('sketchy_llc',  'Sketchy LLC',  0, NULL, NULL, NULL, 'standard'),
  ('unknown_labs', 'Unknown Labs', 0, NULL, NULL, NULL, 'standard');

-- Approved category list (+ one explicitly-unapproved, "crypto", to demo the deny).
INSERT INTO categories (category_id, display_name, approved) VALUES
  ('office_supplies', 'Office Supplies', 1),
  ('software',        'Software',        1),
  ('travel',          'Travel',          1),
  ('automation',      'Automation',      1),
  ('crypto',          'Crypto',          0);

-- agent_47 is cleared for office_supplies + software (NOT travel -> demoable
-- "category approved but agent uncleared" deny).
INSERT INTO agent_category_clearances (agent_id, category_id) VALUES
  ('agent_47', 'office_supplies'),
  ('agent_47', 'software'),
  ('agent_12', 'office_supplies'),
  ('agent_12', 'travel'),
  ('agent_burst', 'automation');

-- Prior spend today for agent_47 totalling 1140 (600 + 540) so 340 more still allows.
INSERT INTO ledger_entries (agent_id, vendor_id, category_id, amount, currency, request_id, ts) VALUES
  ('agent_47', 'acme_corp', 'office_supplies', 600, 'USD', 'req_seed_01', datetime('now')),
  ('agent_47', 'acme_corp', 'software',        540, 'USD', 'req_seed_02', datetime('now')),
  ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_01', datetime('now')),
  ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_02', datetime('now')),
  ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_03', datetime('now')),
  ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_04', datetime('now')),
  ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_05', datetime('now')),
  ('agent_burst', 'acme_corp', 'automation', 5, 'USD', 'req_burst_06', datetime('now')),
  -- agent_12 travel earlier THIS MONTH (not today, not this week): monthly window
  -- sees 1700, daily and weekly see 0. Set up so a monthly budget catches spend a
  -- daily budget cannot — the whole point of windowed budgets.
  ('agent_12', 'acme_corp', 'travel', 850, 'USD', 'req_trav_01', datetime('now', '-12 days')),
  ('agent_12', 'acme_corp', 'travel', 850, 'USD', 'req_trav_02', datetime('now', '-20 days'));

-- Org policy limits.
-- escalation_threshold 400 sits between the hero 340 (ALLOW, unattended) and the
-- 500 hard cap: 340 allows, 450 escalates to a human, 600 denies outright.
-- velocity_limit 6 over a 60-min window: agent_47 has 2 recent settled payments,
-- so the hero and every existing beat are untouched; a 7th payment from a busy
-- agent escalates. Chosen above the seeded counts so nothing pre-existing trips.
INSERT INTO policy_limits (id, per_txn_cap, daily_limit, escalation_threshold, velocity_limit, velocity_window_minutes, currency) VALUES
  (1, 500, 1500, 400, 6, 60, 'USD');

-- Additional budgets (policy.dl D7). Numbers chosen so every demo beat lands
-- where PITCH.md says, which is NOT automatic — the first attempt set
-- vendor_daily/acme_corp to 1200 and broke the hero: agent_47 has already spent
-- 1140 with Acme, so 1140 + 340 = 1480 > 1200 denied the happy path. `pnpm demo`
-- caught it immediately. Arithmetic, given the seeded spend (agent_47: 600
-- office_supplies + 540 software = 1140; agent_12: 0):
--
--   hero      $340 office_supplies a47 -> category 600+340=940 <=1200, vendor
--                                         1140+340=1480 <=2500, daily 1480<=1500  ALLOW
--   beat 2    $400 office_supplies a47 -> daily 1540>1500 DENY. Category 1000<=1200
--                                         and vendor 1540<=2500 stay quiet, so the
--                                         reason PITCH.md quotes verbatim
--                                         ("1140 + 400 > 1500") is still the ONLY one.
--   escalate  $450 office_supplies a12 -> category 600+450=1050 <=1200, so it
--                                         reaches E1 instead of dying on a budget.
--   budget    $300 software        a47 -> category 540+300=840 > 800 DENY
--                                         budget_exceeded, while daily 1440<=1500 and
--                                         cap 300<=500 stay quiet. A budget beat that
--                                         is NOT the daily limit — otherwise D7 would
--                                         only ever be demoed by something D5 catches.
INSERT INTO budgets (scope, key, limit_amount) VALUES
  ('category_daily', 'office_supplies', 1200),
  ('category_daily', 'software',         800),
  ('category_daily', 'travel',          5000),
  -- crypto is approved=0 already; a zero budget is the belt to that braces —
  -- two independent reasons it can never be paid.
  ('category_daily', 'crypto',             0),
  ('category_daily', 'automation',     10000),
  -- Windowed budgets (policy.dl D7, SAME rule): travel accumulates over longer
  -- periods. agent_12 spent 1700 on travel earlier this month; the monthly window
  -- catches spend the daily/weekly windows cannot see. One rule, many periods.
  ('category_weekly',  'travel',         5000),
  ('category_monthly', 'travel',         2000),
  ('vendor_daily',   'acme_corp',       2500),
  ('vendor_daily',   'newco_ltd',        200);

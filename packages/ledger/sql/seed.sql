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
  ('agent_12', 'Ops Agent 12');

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
  ('crypto',          'Crypto',          0);

-- agent_47 is cleared for office_supplies + software (NOT travel -> demoable
-- "category approved but agent uncleared" deny).
INSERT INTO agent_category_clearances (agent_id, category_id) VALUES
  ('agent_47', 'office_supplies'),
  ('agent_47', 'software'),
  ('agent_12', 'office_supplies');

-- Prior spend today for agent_47 totalling 1140 (600 + 540) so 340 more still allows.
INSERT INTO ledger_entries (agent_id, vendor_id, category_id, amount, currency, request_id, ts) VALUES
  ('agent_47', 'acme_corp', 'office_supplies', 600, 'USD', 'req_seed_01', datetime('now')),
  ('agent_47', 'acme_corp', 'software',        540, 'USD', 'req_seed_02', datetime('now'));

-- Org policy limits.
-- escalation_threshold 400 sits between the hero 340 (ALLOW, unattended) and the
-- 500 hard cap: 340 allows, 450 escalates to a human, 600 denies outright.
INSERT INTO policy_limits (id, per_txn_cap, daily_limit, escalation_threshold, currency) VALUES
  (1, 500, 1500, 400, 'USD');

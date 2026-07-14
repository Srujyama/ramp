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

INSERT INTO agents (agent_id, display_name) VALUES
  ('agent_47', 'Procurement Agent 47');

-- Vendor registry: one verified vendor + two unverified (for the spoof/deny beats).
INSERT INTO vendors (vendor_id, display_name, verified, registry_domain, registry_verified_at, registry_method) VALUES
  ('acme_corp',    'Acme Corp',    1, 'acme.example.com', '2026-07-01T00:00:00Z', 'tlsnotary'),
  ('sketchy_llc',  'Sketchy LLC',  0, NULL, NULL, NULL),
  ('unknown_labs', 'Unknown Labs', 0, NULL, NULL, NULL);

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
  ('agent_47', 'software');

-- Prior spend today for agent_47 totalling 1140 (600 + 540) so 340 more still allows.
INSERT INTO ledger_entries (agent_id, vendor_id, category_id, amount, currency, request_id, ts) VALUES
  ('agent_47', 'acme_corp', 'office_supplies', 600, 'USD', 'req_seed_01', datetime('now')),
  ('agent_47', 'acme_corp', 'software',        540, 'USD', 'req_seed_02', datetime('now'));

-- Org policy limits.
INSERT INTO policy_limits (id, per_txn_cap, daily_limit, currency) VALUES
  (1, 500, 1500, 'USD');

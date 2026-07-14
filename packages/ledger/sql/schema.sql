-- ============================================================================
-- @ramp/ledger — authoritative fact store (SQLite)
-- ============================================================================
-- This database + the vendor registry (the `vendors` table) are the ONLY sources
-- of the security-critical facts (daily_total_so_far, vendor_verified, caps).
-- The fact-translation adapter reads from HERE, never from the model's narration.
-- All money is stored as INTEGER whole currency units to keep the kernel's
-- arithmetic exact (no floats).
-- ----------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- Agents that may request spend.
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Vendor registry. `verified` is the AUTHORITATIVE source of `vendor_verified`.
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id            TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  -- 1 iff this vendor is verified in the registry (e.g. via TLSNotary attestation).
  verified             INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  -- Registry provenance fields (who/when/how the vendor was registered).
  registry_domain      TEXT,
  registry_verified_at TEXT,
  registry_method      TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Org-approved spend categories (the approved list).
CREATE TABLE IF NOT EXISTS categories (
  category_id  TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  approved     INTEGER NOT NULL DEFAULT 1 CHECK (approved IN (0, 1))
);

-- Which categories each agent is cleared to spend in.
CREATE TABLE IF NOT EXISTS agent_category_clearances (
  agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  category_id TEXT NOT NULL REFERENCES categories(category_id),
  PRIMARY KEY (agent_id, category_id)
);

-- Immutable spend history. `daily_total_so_far` is derived by summing today's rows.
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  vendor_id   TEXT REFERENCES vendors(vendor_id),
  category_id TEXT REFERENCES categories(category_id),
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  currency    TEXT NOT NULL DEFAULT 'USD',
  request_id  TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_agent_ts ON ledger_entries (agent_id, ts);

-- Org policy limits. Single-row table (id = 1) for the demo org.
CREATE TABLE IF NOT EXISTS policy_limits (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  per_txn_cap INTEGER NOT NULL,
  daily_limit INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD'
);

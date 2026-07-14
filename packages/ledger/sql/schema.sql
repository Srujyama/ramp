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

-- ----------------------------------------------------------------------------
-- Decision log (audit trail). One row per policy decision the GATE makes.
-- Written by the PreToolUse hook via @ramp/ledger's recordDecision() — the hook
-- is the ONLY place that holds the exact Facts + Decision. This table stores the
-- decision verbatim (JSON) for reproduction/audit; persistence NEVER recomputes
-- or reinterprets the policy result. See src/decision-log.ts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  -- Unique per logical attempt (UUID). Idempotency key: repeated delivery of the
  -- same decision_id is a no-op (INSERT OR IGNORE), never an overwrite.
  decision_id         TEXT PRIMARY KEY,
  -- Correlation id (facts.request_id / invoiceRef). NOT unique: two distinct
  -- attempts may share one request_id and are both recorded (distinct decision_id).
  request_id          TEXT NOT NULL,
  -- Terminal persistence status. 'error' = an infra/validation failure recorded
  -- as an audit row (NOT one of the five policy deny rules).
  status              TEXT NOT NULL CHECK (status IN ('allowed', 'denied', 'error')),
  -- The Decision.decision verbatim ('allow'/'deny'); NULL for an 'error' row.
  outcome             TEXT CHECK (outcome IN ('allow', 'deny')),
  agent_id            TEXT NOT NULL,
  vendor_id           TEXT NOT NULL,
  amount              INTEGER NOT NULL,
  category            TEXT NOT NULL,
  -- Day-4 provenance: 1/0 iff a TLSNotary-style attestation accompanied the
  -- request (from Facts.attestation_present). NULL when facts weren't computed.
  attestation_present INTEGER CHECK (attestation_present IN (0, 1)),
  -- Which kernel produced the decision (DescribedKernel.kind), e.g. 'ts-reference'.
  kernel_id           TEXT,
  -- Verbatim JSON blobs. request_json is always present; facts_json/decision_json
  -- are NULL when unavailable (e.g. an error before the kernel ran).
  request_json        TEXT NOT NULL,
  facts_json          TEXT,
  decision_json       TEXT,
  -- Canonical SHA-256 over the semantically-meaningful content (request + facts +
  -- decision + status + kernel + proof id). Idempotency is CONTENT-checked against
  -- this: a repeat of decision_id with an IDENTICAL digest is an idempotent no-op;
  -- a repeat with a DIFFERENT digest is a conflict and is REJECTED (never
  -- overwritten). See recordDecision() in src/decision-log.ts.
  content_digest      TEXT NOT NULL,
  ts                  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Compound (ts, decision_id) indexes back the keyset pagination + every filter.
CREATE INDEX IF NOT EXISTS idx_decisions_ts      ON decisions (ts DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_agent   ON decisions (agent_id, ts DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_vendor  ON decisions (vendor_id, ts DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions (outcome, ts DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions (status, ts DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_request ON decisions (request_id);

-- Fired rules, normalized one-per-row so filtering by rule is indexable and the
-- exact firedRules ORDER is preserved (`ord` = 0-based position). Written in the
-- SAME transaction as the parent decision row (atomic; no partial reads).
CREATE TABLE IF NOT EXISTS decision_fired_rules (
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  rule_id     TEXT NOT NULL,
  PRIMARY KEY (decision_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_fired_rule ON decision_fired_rules (rule_id, decision_id);

-- ----------------------------------------------------------------------------
-- Proof records (tamper-evident attestation, one-per-decision, OPTIONAL).
-- Written in the SAME transaction as the parent decision (atomic). A decision
-- may exist with NO proof row (older/error rows stay readable). The proof_json
-- is the verbatim LedgerProof; proof_id is its stable SHA-256 identity. A
-- duplicate decision_id whose proof differs is rejected upstream via the parent
-- row's content_digest (which folds in proof_id) — proofs are never overwritten.
-- See src/proof.ts + src/decision-log.ts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_proofs (
  decision_id        TEXT PRIMARY KEY REFERENCES decisions(decision_id) ON DELETE CASCADE,
  proof_id           TEXT NOT NULL,
  proof_schema       TEXT NOT NULL,
  attestation_status TEXT NOT NULL
    CHECK (attestation_status IN
      ('absent', 'present_unverified', 'verified', 'verification_failed')),
  proof_json         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proof_id ON decision_proofs (proof_id);

-- ----------------------------------------------------------------------------
-- Sandbox execution receipts (one-per-decision, OPTIONAL).
-- The decision + proof above record what the GATE DECIDED. This table records
-- what the SANDBOX EXECUTOR then DID — closing the "recorded" loop so the
-- receipt an agent received is also auditable, not just returned out-of-band.
-- Written by requestPurchase() AFTER the decision is persisted + independently
-- verified AND the executor runs; a deny never produces a row (nothing executed).
-- A separate, later append: NEVER in the decision's transaction, so it cannot
-- alter or forge the append-only decision/proof record. `status = 'failed'`
-- records a genuine executor failure and MUST NOT be read as a settlement.
-- NO secret-bearing column exists by construction (receiptId/executionId/
-- provider only). See recordExecution() in src/decision-log.ts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_executions (
  decision_id  TEXT PRIMARY KEY REFERENCES decisions(decision_id) ON DELETE CASCADE,
  receipt_id   TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('settled', 'failed')),
  provider     TEXT NOT NULL,
  executed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_execution_receipt ON decision_executions (receipt_id);

-- ============================================================
-- MaintMentor Day 9 Migration: Production Hardening
-- RLS Policies + anomaly_events table + api_keys rotation support
-- Created: 2026-06-07
-- Author: Mack (CTO)
-- ============================================================
-- 
-- NOTE ON SERVICE ROLE:
-- Supabase service_role JWT bypasses ALL RLS policies automatically.
-- The server-side lib/supabase.js uses SUPABASE_SERVICE_KEY which
-- grants service_role access — all server ops continue unaffected.
-- These policies restrict direct ANON/AUTHENTICATED access (e.g. from
-- a future client-side SDK or Supabase Studio with anon key).
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────────
-- TABLE: anomaly_events
-- Stores anomaly detection events for monitoring and audit.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS anomaly_events (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id       UUID,                                -- FK to auth.users (nullable for service events)
  wallet_id     UUID,                                -- FK to wallets
  anomaly_type  TEXT        NOT NULL,                -- CREDIT_BURN_SPIKE | QUERY_VOLUME_SPIKE | REPEATED_402 | REPEATED_RATE_LIMIT
  details       JSONB       NOT NULL DEFAULT '{}',   -- structured context
  alerted       BOOLEAN     NOT NULL DEFAULT FALSE,  -- whether email was sent
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_anomaly_events PRIMARY KEY (id),
  CONSTRAINT chk_anomaly_type CHECK (
    anomaly_type IN (
      'CREDIT_BURN_SPIKE', 'QUERY_VOLUME_SPIKE',
      'REPEATED_402', 'REPEATED_RATE_LIMIT'
    )
  )
);

-- Index: query by user + type + time for cooldown checks (hot path in scanner)
CREATE INDEX IF NOT EXISTS idx_anomaly_events_user_type_time
  ON anomaly_events (user_id, anomaly_type, detected_at DESC);

-- Index: query by wallet for dashboards
CREATE INDEX IF NOT EXISTS idx_anomaly_events_wallet_id
  ON anomaly_events (wallet_id) WHERE wallet_id IS NOT NULL;

-- Enable RLS
ALTER TABLE anomaly_events ENABLE ROW LEVEL SECURITY;


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: wallets
-- Users can see/update only their own wallet.
-- Service role bypasses RLS automatically (no policy needed for server ops).
-- ────────────────────────────────────────────────────────────────────────────

-- Drop existing policies if re-running (idempotent)
DROP POLICY IF EXISTS "wallets_select_own"     ON wallets;
DROP POLICY IF EXISTS "wallets_update_own"     ON wallets;
DROP POLICY IF EXISTS "wallets_insert_own"     ON wallets;

-- SELECT: users can read their own wallet
CREATE POLICY "wallets_select_own"
  ON wallets FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- UPDATE: users can update their own wallet (for auto-recharge toggle etc)
CREATE POLICY "wallets_update_own"
  ON wallets FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT: users can create their own wallet
CREATE POLICY "wallets_insert_own"
  ON wallets FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: api_keys
-- Users can manage only their own API keys.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "api_keys_select_own"   ON api_keys;
DROP POLICY IF EXISTS "api_keys_insert_own"   ON api_keys;
DROP POLICY IF EXISTS "api_keys_update_own"   ON api_keys;
DROP POLICY IF EXISTS "api_keys_delete_own"   ON api_keys;

CREATE POLICY "api_keys_select_own"
  ON api_keys FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "api_keys_insert_own"
  ON api_keys FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "api_keys_update_own"
  ON api_keys FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "api_keys_delete_own"
  ON api_keys FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: wallet_transactions
-- Users can read their own transactions (via wallet ownership).
-- No direct INSERT/UPDATE/DELETE — all mutations go through server RPCs.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "wallet_transactions_select_own" ON wallet_transactions;

CREATE POLICY "wallet_transactions_select_own"
  ON wallet_transactions FOR SELECT
  TO authenticated
  USING (
    wallet_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: api_usage_logs
-- Users can read their own usage logs (via wallet ownership).
-- No user mutations — server-side only.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "api_usage_logs_select_own" ON api_usage_logs;

CREATE POLICY "api_usage_logs_select_own"
  ON api_usage_logs FOR SELECT
  TO authenticated
  USING (
    wallet_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: knowledge_embeddings
-- Public knowledge base — readable by all, writable by service role only.
-- Authenticated users can read (for potential future direct RAG access).
-- Anon can also read (knowledge is not sensitive).
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "knowledge_embeddings_read_all" ON knowledge_embeddings;

CREATE POLICY "knowledge_embeddings_read_all"
  ON knowledge_embeddings FOR SELECT
  TO anon, authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policy for users — service role handles all writes


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: embedding_queue
-- Internal processing queue — no user access.
-- Service role only. Deny all authenticated/anon direct access.
-- (No policies = deny by default when RLS is enabled.)
-- ────────────────────────────────────────────────────────────────────────────

-- embedding_queue: intentionally no policies — service role only
-- (RLS is already enabled from Day 6 migration; no policies = deny for non-service-role)


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: query_history
-- Users can read queries associated with their wallet (via account_id).
-- account_id in query_history maps to wallet_id (see agent.js implementation).
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "query_history_select_own" ON query_history;

CREATE POLICY "query_history_select_own"
  ON query_history FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: usage_tracking
-- Users can read/update their own usage rows.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "usage_tracking_select_own" ON usage_tracking;
DROP POLICY IF EXISTS "usage_tracking_insert_own" ON usage_tracking;
DROP POLICY IF EXISTS "usage_tracking_update_own" ON usage_tracking;

CREATE POLICY "usage_tracking_select_own"
  ON usage_tracking FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "usage_tracking_insert_own"
  ON usage_tracking FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "usage_tracking_update_own"
  ON usage_tracking FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: solana_deposits
-- Users can read their own deposits (via wallet ownership).
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "solana_deposits_select_own" ON solana_deposits;

CREATE POLICY "solana_deposits_select_own"
  ON solana_deposits FOR SELECT
  TO authenticated
  USING (
    wallet_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );


-- ────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES: anomaly_events
-- Users can read anomaly events for their own account.
-- No user writes — server-side detection only.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "anomaly_events_select_own" ON anomaly_events;

CREATE POLICY "anomaly_events_select_own"
  ON anomaly_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────────────────
-- ADD rotated_at COLUMN to api_keys (for key rotation audit trail)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_to UUID; -- ID of the replacement key

COMMENT ON COLUMN api_keys.rotated_at IS 'Timestamp when this key was rotated (replaced by a new key)';
COMMENT ON COLUMN api_keys.rotated_to IS 'ID of the new api_key created to replace this one';

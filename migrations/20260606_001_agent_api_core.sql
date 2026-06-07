-- ============================================================================
-- Migration: 20260606_001_agent_api_core
-- Author:    Mack (CTO, MaintMentor.ai)
-- Date:      2026-06-06
-- Purpose:   Core Agent API + Wallet system tables.
--            Creates api_keys, wallets, wallet_transactions,
--            api_usage_logs, credit_packs, plus the debit_wallet and
--            credit_wallet RPCs required for safe concurrent balance ops.
--
-- Dependencies: auth.users (Supabase built-in)
-- Idempotent:   Yes — all CREATE TABLE/INDEX use IF NOT EXISTS.
-- Rollback:     20260606_001_agent_api_core.rollback.sql
-- ============================================================================

-- ============================================================================
-- TABLE: wallets
-- Must be created before api_keys because api_keys.wallet_id references it.
-- One wallet per user (UNIQUE on user_id).
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallets (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id                   UUID        NOT NULL,
  balance_credits           INTEGER     NOT NULL DEFAULT 0,       -- Current spendable credits
  lifetime_credits          INTEGER     NOT NULL DEFAULT 0,       -- All-time total loaded
  lifetime_spent            INTEGER     NOT NULL DEFAULT 0,       -- All-time total spent
  stripe_customer_id        TEXT,                                 -- Stripe Customer object ID
  stripe_payment_method     TEXT,                                 -- Saved card for auto-recharge
  auto_recharge_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_recharge_threshold   INTEGER     NOT NULL DEFAULT 100,     -- Recharge trigger (credits)
  auto_recharge_amount      INTEGER     NOT NULL DEFAULT 1000,    -- Credits to add on recharge
  low_balance_alert_sent    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_wallets PRIMARY KEY (id),
  CONSTRAINT fk_wallets_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT uq_wallets_user_id UNIQUE (user_id),
  CONSTRAINT chk_wallets_balance_non_negative
    CHECK (balance_credits >= 0),
  CONSTRAINT chk_wallets_lifetime_credits_non_negative
    CHECK (lifetime_credits >= 0),
  CONSTRAINT chk_wallets_lifetime_spent_non_negative
    CHECK (lifetime_spent >= 0),
  CONSTRAINT chk_wallets_auto_recharge_threshold_positive
    CHECK (auto_recharge_threshold > 0),
  CONSTRAINT chk_wallets_auto_recharge_amount_positive
    CHECK (auto_recharge_amount > 0)
);

-- Index justification: dashboard + middleware load wallet by user_id on every request.
CREATE INDEX IF NOT EXISTS idx_wallets_user_id
  ON wallets (user_id);

-- Index justification: auto-recharge cron queries wallets with enabled recharge + low balance.
CREATE INDEX IF NOT EXISTS idx_wallets_auto_recharge
  ON wallets (auto_recharge_enabled, balance_credits)
  WHERE auto_recharge_enabled = TRUE;


-- ============================================================================
-- TABLE: api_keys
-- Stores hashed API keys. Raw key is NEVER stored — SHA-256 hash only.
-- Depends on: wallets, auth.users
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  wallet_id       UUID        NOT NULL,
  key_hash        TEXT        NOT NULL,  -- SHA-256 of the raw key; used for auth lookups
  key_prefix      TEXT        NOT NULL,  -- First 8 chars shown in UI (e.g. "mm_pk_a1b2")
  label           TEXT,                  -- Friendly name ("My Production Key")
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT pk_api_keys PRIMARY KEY (id),
  CONSTRAINT fk_api_keys_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_keys_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  CONSTRAINT uq_api_keys_key_hash UNIQUE (key_hash),
  CONSTRAINT chk_api_keys_key_prefix_format
    CHECK (key_prefix ~ '^mm_pk_[0-9a-f]{8}$'),
  CONSTRAINT chk_api_keys_revoked_consistency
    CHECK (
      (revoked_at IS NULL AND is_active = TRUE)
      OR (revoked_at IS NOT NULL AND is_active = FALSE)
      OR (revoked_at IS NULL AND is_active = FALSE)  -- manually deactivated without formal revoke
    )
);

-- Index justification: auth middleware hashes incoming Bearer token and looks up by key_hash
-- on every single API request. This is the hottest query in the system.
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON api_keys (key_hash);

-- Index justification: dashboard lists keys by wallet; wallet is the primary unit of billing.
CREATE INDEX IF NOT EXISTS idx_api_keys_wallet_id
  ON api_keys (wallet_id);

-- Index justification: admin queries filter for active keys only; partial index is smaller and faster.
CREATE INDEX IF NOT EXISTS idx_api_keys_wallet_id_active
  ON api_keys (wallet_id)
  WHERE is_active = TRUE;


-- ============================================================================
-- TABLE: api_usage_logs
-- Immutable audit log of every API call. Written once, never updated.
-- Depends on: api_keys, wallets
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_usage_logs (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  api_key_id        UUID,                           -- Nullable: key may be deleted later
  wallet_id         UUID,                           -- Nullable: denormalized for fast wallet queries
  endpoint          TEXT        NOT NULL,           -- e.g. "/api/agent/query"
  method            TEXT        NOT NULL DEFAULT 'POST',
  tokens_used       INTEGER,                        -- AI tokens consumed (null if not applicable)
  credits_charged   INTEGER     NOT NULL,
  response_status   INTEGER,                        -- HTTP status returned to client
  latency_ms        INTEGER,                        -- Total wall-clock time
  request_metadata  JSONB,                          -- Sanitized summary — NO PII, NO raw key
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_api_usage_logs PRIMARY KEY (id),
  CONSTRAINT fk_api_usage_logs_api_key_id
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
  CONSTRAINT fk_api_usage_logs_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL,
  CONSTRAINT chk_api_usage_logs_credits_non_negative
    CHECK (credits_charged >= 0),
  CONSTRAINT chk_api_usage_logs_method
    CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT chk_api_usage_logs_latency_non_negative
    CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

-- Index justification: developer dashboard + /api/agent/usage endpoint paginates logs by key.
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_api_key_created
  ON api_usage_logs (api_key_id, created_at DESC);

-- Index justification: billing reconciliation and wallet transaction history query by wallet.
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_wallet_created
  ON api_usage_logs (wallet_id, created_at DESC);

-- Index justification: daily monitoring cron scans for errors (response_status >= 400).
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_status_created
  ON api_usage_logs (response_status, created_at DESC)
  WHERE response_status >= 400;


-- ============================================================================
-- TABLE: wallet_transactions
-- Every credit and debit to a wallet. Paired with api_usage_logs for debits.
-- Depends on: wallets, api_usage_logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                          UUID    NOT NULL DEFAULT gen_random_uuid(),
  wallet_id                   UUID    NOT NULL,
  type                        TEXT    NOT NULL,       -- 'credit' or 'debit'
  amount_credits              INTEGER NOT NULL,       -- Always positive; type field disambiguates direction
  balance_after               INTEGER NOT NULL,       -- Snapshot of balance after this transaction
  description                 TEXT,                  -- e.g. "Purchase: $25 pack", "API call: /agent/query"
  stripe_payment_intent_id    TEXT,                  -- Set on Stripe purchase transactions (idempotency key)
  api_log_id                  UUID,                  -- Set on debit transactions; links to api_usage_logs
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_wallet_transactions PRIMARY KEY (id),
  CONSTRAINT fk_wallet_transactions_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_transactions_api_log_id
    FOREIGN KEY (api_log_id) REFERENCES api_usage_logs(id) ON DELETE SET NULL,
  CONSTRAINT chk_wallet_transactions_type
    CHECK (type IN ('credit', 'debit')),
  CONSTRAINT chk_wallet_transactions_amount_positive
    CHECK (amount_credits > 0),
  CONSTRAINT chk_wallet_transactions_balance_non_negative
    CHECK (balance_after >= 0),
  -- Stripe idempotency: a given payment intent can only credit a wallet once
  CONSTRAINT uq_wallet_transactions_stripe_payment_intent
    UNIQUE (stripe_payment_intent_id)
);

-- Index justification: wallet history endpoint orders by recency; wallet_id + DESC is the primary access pattern.
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_created
  ON wallet_transactions (wallet_id, created_at DESC);

-- Index justification: Stripe idempotency check on webhook receipt — must be fast.
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_stripe_intent
  ON wallet_transactions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Index justification: debit reconciliation queries (match transactions back to usage logs).
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_api_log_id
  ON wallet_transactions (api_log_id)
  WHERE api_log_id IS NOT NULL;


-- ============================================================================
-- TABLE: credit_packs
-- Configuration table defining purchasable credit bundles.
-- Not user data — no RLS needed, but referenced by checkout flow.
-- ============================================================================
CREATE TABLE IF NOT EXISTS credit_packs (
  id              UUID    NOT NULL DEFAULT gen_random_uuid(),
  name            TEXT    NOT NULL,         -- "Starter", "Pro", "Scale"
  price_cents     INTEGER NOT NULL,         -- 2500 = $25.00
  credits         INTEGER NOT NULL,         -- 1000
  stripe_price_id TEXT    NOT NULL,         -- Stripe Price object ID (set after Stripe setup)
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_credit_packs PRIMARY KEY (id),
  CONSTRAINT uq_credit_packs_name UNIQUE (name),
  CONSTRAINT uq_credit_packs_stripe_price_id UNIQUE (stripe_price_id),
  CONSTRAINT chk_credit_packs_price_positive
    CHECK (price_cents > 0),
  CONSTRAINT chk_credit_packs_credits_positive
    CHECK (credits > 0)
);

-- Index justification: checkout page loads active packs only; this partial index keeps it tight.
CREATE INDEX IF NOT EXISTS idx_credit_packs_active
  ON credit_packs (is_active)
  WHERE is_active = TRUE;


-- ============================================================================
-- SEED DATA: credit_packs
-- Initial three credit pack tiers. stripe_price_id placeholders must be
-- replaced with real Stripe Price IDs before first Stripe checkout attempt.
-- See: Open Questions Section 10 of agent-api-wallet-spec.md
-- ============================================================================
INSERT INTO credit_packs (name, price_cents, credits, stripe_price_id, is_active)
VALUES
  ('Starter', 2500,  1000,  'price_REPLACE_STARTER_PRICE_ID',  TRUE),
  ('Pro',     9900,  5000,  'price_REPLACE_PRO_PRICE_ID',      TRUE),
  ('Scale',   49900, 25000, 'price_REPLACE_SCALE_PRICE_ID',    TRUE)
ON CONFLICT (name) DO UPDATE SET
  price_cents     = EXCLUDED.price_cents,
  credits         = EXCLUDED.credits,
  is_active       = EXCLUDED.is_active
  -- NOTE: stripe_price_id is intentionally NOT updated on conflict — once set to a real
  -- Stripe Price ID, it must never be overwritten by a re-run of this migration.
;


-- ============================================================================
-- RPC: debit_wallet
-- Atomically deducts credits from a wallet using FOR UPDATE row locking.
-- This MUST be an RPC — application-level SELECT then UPDATE has a TOCTOU
-- race condition. The FOR UPDATE lock is only valid within a single DB transaction.
--
-- Returns JSONB:
--   { "success": true, "balance_after": N }
--   { "success": false, "error": "wallet_not_found" | "insufficient_balance", "balance": N }
-- ============================================================================
CREATE OR REPLACE FUNCTION debit_wallet(
  p_wallet_id   UUID,
  p_credits     INTEGER,
  p_description TEXT DEFAULT 'API call'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet      wallets%ROWTYPE;
  v_new_balance INTEGER;
BEGIN
  IF p_credits <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  -- Lock the wallet row for this transaction. No other transaction can read or
  -- write this row until we COMMIT or ROLLBACK. This is the race condition fix.
  SELECT * INTO v_wallet
  FROM wallets
  WHERE id = p_wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
  END IF;

  IF v_wallet.balance_credits < p_credits THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_balance',
      'balance', v_wallet.balance_credits
    );
  END IF;

  v_new_balance := v_wallet.balance_credits - p_credits;

  UPDATE wallets
  SET
    balance_credits  = v_new_balance,
    lifetime_spent   = lifetime_spent + p_credits,
    updated_at       = NOW()
  WHERE id = p_wallet_id;

  -- Log the transaction atomically in the same DB transaction.
  INSERT INTO wallet_transactions
    (wallet_id, type, amount_credits, balance_after, description)
  VALUES
    (p_wallet_id, 'debit', p_credits, v_new_balance, p_description);

  RETURN jsonb_build_object('success', true, 'balance_after', v_new_balance);
END;
$$;


-- ============================================================================
-- RPC: credit_wallet
-- Atomically adds credits to a wallet.
-- Used by: Stripe webhook handler, Solana deposit handler.
-- Returns JSONB: { "success": true, "balance_after": N }
-- ============================================================================
CREATE OR REPLACE FUNCTION credit_wallet(
  p_wallet_id   UUID,
  p_credits     INTEGER,
  p_description TEXT DEFAULT 'Credit purchase'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  IF p_credits <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  UPDATE wallets
  SET
    balance_credits  = balance_credits + p_credits,
    lifetime_credits = lifetime_credits + p_credits,
    updated_at       = NOW()
  WHERE id = p_wallet_id
  RETURNING balance_credits INTO v_new_balance;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
  END IF;

  -- Log the transaction.
  INSERT INTO wallet_transactions
    (wallet_id, type, amount_credits, balance_after, description)
  VALUES
    (p_wallet_id, 'credit', p_credits, v_new_balance, p_description);

  RETURN jsonb_build_object('success', true, 'balance_after', v_new_balance);
END;
$$;


-- ============================================================================
-- TRIGGER: wallets_updated_at
-- Auto-updates the updated_at column on every wallet row modification.
-- ============================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallets_updated_at ON wallets;
CREATE TRIGGER trg_wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();


-- ============================================================================
-- ALERT TRIGGER: negative_balance_guard
-- Database-level safety net. If balance_credits somehow goes negative
-- (should be impossible with debit_wallet RPC + CHECK constraint), fire an alert.
-- Belt and suspenders — the CHECK constraint is the primary guard.
-- ============================================================================
CREATE OR REPLACE FUNCTION alert_negative_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance_credits < 0 THEN
    -- pg_net is available on Supabase Pro. If not available, this is a no-op
    -- but the CHECK constraint on balance_credits will block the INSERT/UPDATE anyway.
    RAISE WARNING '[CRITICAL] Wallet % balance went negative: %. This should never happen.',
      NEW.id, NEW.balance_credits;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallets_negative_balance_guard ON wallets;
CREATE TRIGGER trg_wallets_negative_balance_guard
  AFTER INSERT OR UPDATE ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION alert_negative_balance();


-- ============================================================================
-- VERIFICATION QUERIES
-- Run these after migration to confirm success.
-- Expected: all 5 tables exist, seed data present, RPCs callable.
--
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs')
--   ORDER BY table_name;
-- Expected: 5 rows
--
-- SELECT name, price_cents, credits FROM credit_packs ORDER BY price_cents;
-- Expected: Starter $25/1000, Pro $99/5000, Scale $499/25000
--
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--   AND routine_name IN ('debit_wallet','credit_wallet','trigger_set_updated_at','alert_negative_balance');
-- Expected: 4 rows
-- ============================================================================

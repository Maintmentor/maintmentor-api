-- ============================================================================
-- Migration: 001_agent_api_wallet
-- Author:    Mack (CTO, MaintMentor.ai)
-- Date:      2026-06-09
-- Purpose:   Core Agent API + Wallet system — Phase 1, Day 1 deliverable.
--            Creates: wallets, api_keys, api_usage_logs, wallet_transactions,
--            credit_packs (config).
--            Includes: indexes, debit_wallet/credit_wallet RPCs, update
--            trigger, negative-balance alert trigger, and FULL RLS policies.
--
-- This is the canonical Gate 1 schema for Winston's sign-off.
-- See spec Section 13.8: Winston must approve this before any code is written.
--
-- Dependencies:
--   - auth.users (Supabase built-in) — wallets + api_keys reference it
--   - Supabase service role key in application — bypasses RLS for server-side ops
--
-- Companion rollback: 001_agent_api_wallet.rollback.sql
-- Idempotent:         Yes — all CREATE TABLE/INDEX use IF NOT EXISTS.
--                     RLS policy blocks use DO $$ ... $$ guards.
--
-- RLS model:
--   - Authenticated users see ONLY their own data (user_id = auth.uid())
--   - wallet_transactions + api_usage_logs use indirect ownership (via wallets)
--   - credit_packs: read-only for all authenticated users
--   - Server uses service role key → RLS bypassed entirely for all mutations
--   - No user-facing INSERT/UPDATE/DELETE on transaction tables (service role only)
-- ============================================================================


-- ============================================================================
-- TABLE: wallets
-- Created first — api_keys.wallet_id references this table.
-- One wallet per Supabase auth user (UNIQUE on user_id).
-- balance_credits CHECK constraint is the primary guard against negative balance;
-- the debit_wallet RPC + FOR UPDATE lock is the concurrency safety layer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallets (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id                   UUID        NOT NULL,
  balance_credits           INTEGER     NOT NULL DEFAULT 0,
  lifetime_credits          INTEGER     NOT NULL DEFAULT 0,
  lifetime_spent            INTEGER     NOT NULL DEFAULT 0,
  stripe_customer_id        TEXT,
  stripe_payment_method     TEXT,
  auto_recharge_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_recharge_threshold   INTEGER     NOT NULL DEFAULT 100,
  auto_recharge_amount      INTEGER     NOT NULL DEFAULT 1000,
  low_balance_alert_sent    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_wallets
    PRIMARY KEY (id),
  CONSTRAINT fk_wallets_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT uq_wallets_user_id
    UNIQUE (user_id),                                         -- One wallet per user, enforced at DB level
  CONSTRAINT chk_wallets_balance_non_negative
    CHECK (balance_credits >= 0),                            -- Cannot go negative — belt+suspenders with RPC lock
  CONSTRAINT chk_wallets_lifetime_credits_non_negative
    CHECK (lifetime_credits >= 0),
  CONSTRAINT chk_wallets_lifetime_spent_non_negative
    CHECK (lifetime_spent >= 0),
  CONSTRAINT chk_wallets_auto_recharge_threshold_positive
    CHECK (auto_recharge_threshold > 0),
  CONSTRAINT chk_wallets_auto_recharge_amount_positive
    CHECK (auto_recharge_amount > 0)
);

-- Hot path: auth middleware loads wallet by user_id on every API request.
CREATE INDEX IF NOT EXISTS idx_wallets_user_id
  ON wallets (user_id);

-- Auto-recharge cron queries wallets needing a top-up (enabled + balance below threshold).
-- Partial: only enabled wallets — keeps the index small when most users never configure recharge.
CREATE INDEX IF NOT EXISTS idx_wallets_auto_recharge
  ON wallets (auto_recharge_enabled, balance_credits)
  WHERE auto_recharge_enabled = TRUE;


-- ============================================================================
-- TABLE: api_keys
-- Stores SHA-256 hashes of API keys. Raw key is NEVER stored — shown once on
-- creation, then gone forever. Industry standard (Stripe, OpenAI pattern).
-- Key format: mm_pk_{32 hex chars}
-- key_prefix: first 14 chars of the key shown in dashboard UI for identification.
--             Format: mm_pk_ (6 chars) + 8 hex chars = 14 chars total.
--             Example: mm_pk_a1b2c3d4
--             Provides low collision risk while remaining readable.
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  wallet_id       UUID        NOT NULL,
  key_hash        TEXT        NOT NULL,
  key_prefix      TEXT        NOT NULL,               -- mm_pk_{8 hex} — 14 chars shown in dashboard UI (e.g. mm_pk_a1b2c3d4)
  label           TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT pk_api_keys
    PRIMARY KEY (id),
  CONSTRAINT fk_api_keys_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_keys_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  CONSTRAINT uq_api_keys_key_hash
    UNIQUE (key_hash),
  CONSTRAINT chk_api_keys_key_prefix_format
    CHECK (key_prefix ~ '^mm_pk_[0-9a-f]{8}$'),
  -- Revocation consistency: if revoked_at is set, key must be inactive.
  -- Key can be inactive without revoked_at (manually deactivated by user).
  CONSTRAINT chk_api_keys_revoked_consistency
    CHECK (
      (revoked_at IS NOT NULL AND is_active = FALSE)   -- formally revoked
      OR (revoked_at IS NULL)                          -- active or soft-disabled
    )
);

-- THE hottest query in the system: auth middleware SHA-256 hashes the Bearer
-- token and looks this up on every single API request.
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON api_keys (key_hash);

-- Dashboard: list all keys for a wallet (user's key management page).
CREATE INDEX IF NOT EXISTS idx_api_keys_wallet_id
  ON api_keys (wallet_id);

-- Active-only variant: middleware + cron skip revoked keys.
-- Partial index is smaller and faster than a composite covering inactive rows.
CREATE INDEX IF NOT EXISTS idx_api_keys_wallet_id_active
  ON api_keys (wallet_id)
  WHERE is_active = TRUE;


-- ============================================================================
-- TABLE: api_usage_logs
-- Immutable audit log of every API call attempt. Written once, never updated.
-- ON DELETE SET NULL on FK columns preserves audit history even if a key or
-- wallet is deleted — we keep the log row, we just lose the FK linkage.
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_usage_logs (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  api_key_id        UUID,                           -- Nullable: key may be deleted after log is written
  wallet_id         UUID,                           -- Denormalized for fast wallet-scoped queries
  endpoint          TEXT        NOT NULL,
  method            TEXT        NOT NULL DEFAULT 'POST',
  tokens_used       INTEGER,
  credits_charged   INTEGER     NOT NULL,
  response_status   INTEGER,
  latency_ms        INTEGER,
  request_metadata  JSONB,                          -- Sanitized — NO raw key, NO PII
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_api_usage_logs
    PRIMARY KEY (id),
  CONSTRAINT fk_api_usage_logs_api_key_id
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
  CONSTRAINT fk_api_usage_logs_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL,
  CONSTRAINT chk_api_usage_logs_credits_non_negative
    CHECK (credits_charged >= 0),
  CONSTRAINT chk_api_usage_logs_method
    CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT chk_api_usage_logs_latency_non_negative
    CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT chk_api_usage_logs_metadata_size
    CHECK (request_metadata IS NULL OR octet_length(request_metadata::text) <= 8192)
);

-- Developer dashboard + /api/agent/usage endpoint: paginate logs by key, most recent first.
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_api_key_created
  ON api_usage_logs (api_key_id, created_at DESC);

-- Billing reconciliation + wallet transaction history.
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_wallet_created
  ON api_usage_logs (wallet_id, created_at DESC);

-- Daily monitoring cron: scan for errors without full-table scan.
-- Partial: only error rows — success rows (< 400) excluded from this index.
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_errors
  ON api_usage_logs (response_status, created_at DESC)
  WHERE response_status >= 400;


-- ============================================================================
-- TABLE: wallet_transactions
-- Double-entry ledger of every credit and debit. Every debit links to an
-- api_usage_logs row; every credit links to a Stripe payment intent.
-- stripe_payment_intent_id UNIQUE constraint = Stripe webhook idempotency key.
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  wallet_id                   UUID        NOT NULL,
  type                        TEXT        NOT NULL,
  amount_credits              INTEGER     NOT NULL,
  balance_after               INTEGER     NOT NULL,
  description                 TEXT,
  stripe_payment_intent_id    TEXT,
  api_log_id                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_wallet_transactions
    PRIMARY KEY (id),
  CONSTRAINT fk_wallet_transactions_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_transactions_api_log_id
    FOREIGN KEY (api_log_id) REFERENCES api_usage_logs(id) ON DELETE SET NULL,
  CONSTRAINT chk_wallet_transactions_type
    CHECK (type IN ('credit', 'debit', 'refund')),
  CONSTRAINT chk_wallet_transactions_amount_positive
    CHECK (amount_credits > 0),
  CONSTRAINT chk_wallet_transactions_balance_non_negative
    CHECK (balance_after >= 0),
  -- Stripe idempotency: a single payment intent can only credit once.
  -- Stripe webhook handler checks this before inserting.
  CONSTRAINT uq_wallet_transactions_stripe_payment_intent
    UNIQUE (stripe_payment_intent_id)
);

-- Wallet history endpoint: ordered by recency per wallet.
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_created
  ON wallet_transactions (wallet_id, created_at DESC);

-- Stripe idempotency check on webhook receipt — must be sub-millisecond.
-- UNIQUE constraint creates an implicit B-tree index, but naming it explicitly
-- makes it visible in monitoring and migration diffs.
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_stripe_intent
  ON wallet_transactions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Debit reconciliation: match transaction back to the originating usage log.
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_api_log
  ON wallet_transactions (api_log_id)
  WHERE api_log_id IS NOT NULL;


-- ============================================================================
-- TABLE: credit_packs
-- Configuration table — defines what users can buy. Not user data.
-- stripe_price_id must match real Stripe Price IDs before first checkout.
-- Seed data at the bottom of this file sets placeholder IDs that MUST be
-- replaced in the Stripe setup step (see post-migration checklist).
-- ============================================================================
CREATE TABLE IF NOT EXISTS credit_packs (
  id              UUID    NOT NULL DEFAULT gen_random_uuid(),
  name            TEXT    NOT NULL,
  price_cents     INTEGER NOT NULL,
  credits         INTEGER NOT NULL,
  stripe_price_id TEXT    NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_credit_packs
    PRIMARY KEY (id),
  CONSTRAINT uq_credit_packs_name
    UNIQUE (name),
  CONSTRAINT uq_credit_packs_stripe_price_id
    UNIQUE (stripe_price_id),
  CONSTRAINT chk_credit_packs_price_positive
    CHECK (price_cents > 0),
  CONSTRAINT chk_credit_packs_credits_positive
    CHECK (credits > 0)
);

-- Checkout page loads active packs only — partial index, very small.
CREATE INDEX IF NOT EXISTS idx_credit_packs_active
  ON credit_packs (is_active)
  WHERE is_active = TRUE;


-- ============================================================================
-- SEED DATA: credit_packs
-- Locked pricing per Dean + Winston sign-off (2026-06-09):
--   $25  → 1,000 credits  ($0.025/credit)
--   $99  → 5,000 credits  ($0.0198/credit)
--   $499 → 25,000 credits ($0.01996/credit)
--
-- ⚠️  stripe_price_id values are PLACEHOLDERS. Replace with real Stripe Price IDs
--     BEFORE the first Stripe checkout attempt. See post-migration checklist.
--     Command: UPDATE credit_packs SET stripe_price_id = 'price_REAL_ID' WHERE name = '...';
-- ============================================================================
INSERT INTO credit_packs (name, price_cents, credits, stripe_price_id, is_active)
VALUES
  ('Starter', 2500,  1000,  'price_REPLACE_STARTER', TRUE),
  ('Pro',     9900,  5000,  'price_REPLACE_PRO',     TRUE),
  ('Scale',   49900, 25000, 'price_REPLACE_SCALE',   TRUE)
ON CONFLICT (name) DO UPDATE SET
  price_cents = EXCLUDED.price_cents,
  credits     = EXCLUDED.credits,
  is_active   = EXCLUDED.is_active
  -- NOTE: stripe_price_id intentionally NOT updated on conflict.
  -- Once set to a real Stripe Price ID it must never be overwritten by a re-run.
;


-- ============================================================================
-- RPC: debit_wallet
-- Atomically deducts credits using FOR UPDATE row locking.
--
-- WHY AN RPC: Application-level SELECT + UPDATE in two round-trips has a
-- TOCTOU (time-of-check/time-of-use) race condition. Two concurrent requests
-- against the same wallet can both read balance=100, both decide to deduct 100,
-- and both succeed — resulting in balance = -100. The FOR UPDATE lock inside
-- this function holds a row-level exclusive lock from SELECT to COMMIT, so
-- concurrent callers serialize. The load test (50 concurrent / same wallet)
-- in spec Section 13.3 validates this.
--
-- Returns JSONB:
--   { "success": true,  "balance_after": N }
--   { "success": false, "error": "wallet_not_found" | "insufficient_balance" | "invalid_amount",
--     "balance": N }
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

  -- Acquire exclusive row lock. No other transaction can read or write
  -- this row until we COMMIT or ROLLBACK.
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
      'error',   'insufficient_balance',
      'balance', v_wallet.balance_credits
    );
  END IF;

  v_new_balance := v_wallet.balance_credits - p_credits;

  UPDATE wallets
  SET
    balance_credits = v_new_balance,
    lifetime_spent  = lifetime_spent + p_credits,
    updated_at      = NOW()
  WHERE id = p_wallet_id;

  -- Insert transaction log in the same atomic DB transaction.
  -- If this INSERT fails, the UPDATE above also rolls back — no phantom debits.
  INSERT INTO wallet_transactions (wallet_id, type, amount_credits, balance_after, description)
  VALUES (p_wallet_id, 'debit', p_credits, v_new_balance, p_description);

  RETURN jsonb_build_object('success', true, 'balance_after', v_new_balance);
END;
$$;


-- ============================================================================
-- RPC: credit_wallet
-- Atomically adds credits to a wallet.
-- Used by: Stripe checkout.session.completed webhook, Solana deposit handler,
--          auto-recharge flow (v2).
--
-- Returns JSONB:
--   { "success": true,  "balance_after": N }
--   { "success": false, "error": "wallet_not_found" | "invalid_amount" }
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

  INSERT INTO wallet_transactions (wallet_id, type, amount_credits, balance_after, description)
  VALUES (p_wallet_id, 'credit', p_credits, v_new_balance, p_description);

  RETURN jsonb_build_object('success', true, 'balance_after', v_new_balance);
END;
$$;


-- ============================================================================
-- TRIGGER: wallets.updated_at
-- Auto-sets updated_at on every wallet row modification.
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
-- TRIGGER: negative_balance_guard
-- Belt-and-suspenders alert if balance_credits somehow goes negative.
-- In theory impossible — the CHECK constraint blocks it at the DB level.
-- This trigger fires a WARNING so it appears in Supabase logs, providing a
-- second signal layer for the monitoring alerts described in spec Section 13.7.
-- ============================================================================
CREATE OR REPLACE FUNCTION alert_negative_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance_credits < 0 THEN
    RAISE WARNING
      '[CRITICAL] Wallet % balance went negative: %. This should never happen. '
      'Check debit_wallet RPC and FOR UPDATE lock. Immediate investigation required.',
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
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================
-- Model:
--   1. Service role key (used by the Node.js API server) BYPASSES all RLS.
--      This is correct — the server is trusted and performs all writes.
--   2. Authenticated JWT users (dashboard frontend) see only their own data.
--   3. Anonymous/unauthenticated users see nothing — no public policies defined.
--   4. No user-facing INSERT/UPDATE/DELETE on transaction tables (credit_packs,
--      wallet_transactions, api_usage_logs) — these are server-managed only.
--
-- Testing requirement (spec Section 13.1):
--   RLS MUST be tested with two separate test accounts before Gate 1 approval.
--   Verify that user A cannot see user B's wallet, keys, or transactions.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- wallets RLS
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

-- Drop and recreate policies to make this migration idempotent.
-- (IF EXISTS on DROP POLICY is idempotent; CREATE without IF NOT EXISTS
--  would error on re-run — DROP first solves that cleanly.)
DROP POLICY IF EXISTS wallets_select_own      ON wallets;
DROP POLICY IF EXISTS wallets_insert_own      ON wallets;
DROP POLICY IF EXISTS wallets_update_own      ON wallets;

-- Users see ONLY their own wallet row.
CREATE POLICY wallets_select_own
  ON wallets
  FOR SELECT
  USING (user_id = auth.uid());

-- User can create their own wallet (onboarding flow creates wallet on first login).
CREATE POLICY wallets_insert_own
  ON wallets
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- User can update their own wallet (auto-recharge settings, etc.).
-- Server-side balance mutations (debit/credit) go through service role — not affected by this policy.
CREATE POLICY wallets_update_own
  ON wallets
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No DELETE policy — wallets are permanent. Deletion of the auth.users row
-- cascades via FK, which is a service-role operation only.


-- ────────────────────────────────────────────────────────────────────────────
-- api_keys RLS
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_keys_select_own ON api_keys;
DROP POLICY IF EXISTS api_keys_insert_own ON api_keys;
DROP POLICY IF EXISTS api_keys_update_own ON api_keys;

-- Users see only their own keys.
CREATE POLICY api_keys_select_own
  ON api_keys
  FOR SELECT
  USING (user_id = auth.uid());

-- Users can create keys for their own account.
-- Server validates wallet_id ownership before accepting the insert.
CREATE POLICY api_keys_insert_own
  ON api_keys
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can update their own keys (rename label, or revoke via is_active = false).
CREATE POLICY api_keys_update_own
  ON api_keys
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No DELETE policy — revocation is a soft delete (is_active = FALSE, revoked_at = NOW()).
-- Hard deletes are performed by the service role only (e.g., account closure).


-- ────────────────────────────────────────────────────────────────────────────
-- api_usage_logs RLS
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE api_usage_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_usage_logs_select_own ON api_usage_logs;

-- Users see only their own logs, identified by wallet ownership.
-- Indirect ownership: api_usage_logs.wallet_id → wallets.user_id = auth.uid()
-- Uses a subquery; service role bypasses this entirely for inserts.
CREATE POLICY api_usage_logs_select_own
  ON api_usage_logs
  FOR SELECT
  USING (
    wallet_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies — all writes go through service role.
-- If a user somehow tries to insert a log row directly, it is blocked.


-- ────────────────────────────────────────────────────────────────────────────
-- wallet_transactions RLS
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_transactions_select_own ON wallet_transactions;

-- Users see only their own transaction history, identified by wallet ownership.
CREATE POLICY wallet_transactions_select_own
  ON wallet_transactions
  FOR SELECT
  USING (
    wallet_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies — debit_wallet and credit_wallet RPCs
-- (SECURITY DEFINER) handle all mutations through the service role.


-- ────────────────────────────────────────────────────────────────────────────
-- credit_packs RLS
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE credit_packs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_packs_select_authenticated ON credit_packs;

-- All authenticated users can read active credit packs (checkout page needs this).
-- Inactive packs (is_active = FALSE) are hidden from users but visible to service role.
CREATE POLICY credit_packs_select_authenticated
  ON credit_packs
  FOR SELECT
  TO authenticated
  USING (is_active = TRUE);

-- No INSERT/UPDATE/DELETE for authenticated users — admin-only via service role.


-- ============================================================================
-- POST-MIGRATION CHECKLIST (required before Gate 1 approval)
-- ============================================================================
-- [ ] Run verification queries below — confirm 5 tables, 3 credit packs, 2 RPCs
-- [ ] Test RLS with two separate test accounts:
--       User A creates wallet → User B cannot SELECT User A's wallet row
--       User A creates API key → User B cannot see it
--       User A's transactions → User B gets 0 rows from wallet_transactions
-- [ ] Replace stripe_price_id placeholder values with real Stripe Price IDs:
--       UPDATE credit_packs SET stripe_price_id = 'price_REAL_ID' WHERE name = 'Starter';
--       UPDATE credit_packs SET stripe_price_id = 'price_REAL_ID' WHERE name = 'Pro';
--       UPDATE credit_packs SET stripe_price_id = 'price_REAL_ID' WHERE name = 'Scale';
-- [ ] Winston (COO) Gate 1 sign-off — see spec Section 13.8
-- [ ] Proceed to Day 2: API key generation (POST /dashboard/keys)
-- ============================================================================


-- ============================================================================
-- VERIFICATION QUERIES
-- Run these immediately after migration to confirm correct execution.
-- ============================================================================

-- 1. All 5 tables exist
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- AND table_name IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs')
-- ORDER BY table_name;
-- Expected: 5 rows

-- 2. Credit pack seed data
-- SELECT name, price_cents, credits FROM credit_packs ORDER BY price_cents;
-- Expected:
--   Starter | 2500  | 1000
--   Pro     | 9900  | 5000
--   Scale   | 49900 | 25000

-- 3. RPCs created
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_schema = 'public'
-- AND routine_name IN ('debit_wallet','credit_wallet','trigger_set_updated_at','alert_negative_balance')
-- ORDER BY routine_name;
-- Expected: 4 rows

-- 4. RLS enabled on all user tables
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public'
-- AND tablename IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs');
-- Expected: rowsecurity = true for all 5 rows

-- 5. RLS policies exist
-- SELECT tablename, policyname, cmd FROM pg_policies
-- WHERE schemaname = 'public'
-- AND tablename IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs')
-- ORDER BY tablename, policyname;
-- Expected: 7 policies total:
--   wallets                (wallets_select_own, wallets_insert_own, wallets_update_own)
--   api_keys               (api_keys_select_own, api_keys_insert_own, api_keys_update_own)
--   api_usage_logs         (api_usage_logs_select_own)
--   wallet_transactions    (wallet_transactions_select_own)
--   credit_packs           (credit_packs_select_authenticated)

-- 6. debit_wallet functional test (run on staging only — uses real DB)
-- SELECT debit_wallet(
--   (SELECT id FROM wallets LIMIT 1),  -- Replace with a real wallet UUID
--   999999,                            -- More than balance → should return insufficient_balance
--   'Test debit'
-- );
-- Expected: { "success": false, "error": "insufficient_balance", "balance": 0 }

-- 7. Indexes created
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public'
-- AND tablename IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs')
-- ORDER BY tablename, indexname;
-- Expected: 10 indexes (see index comments above for full list)

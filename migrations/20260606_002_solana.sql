-- ============================================================================
-- Migration: 20260606_002_solana
-- Author:    Mack (CTO, MaintMentor.ai)
-- Date:      2026-06-06
-- Purpose:   Solana wallet layer — agent-to-agent USDC micropayments.
--            Extends wallets with Solana columns and adds solana_deposits table.
--
-- Dependencies: 20260606_001_agent_api_core (wallets table must exist)
-- Idempotent:   Yes — ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
-- Rollback:     20260606_002_solana.rollback.sql
--
-- Spec ref:  agent-api-wallet-spec.md Section 11
-- ============================================================================

-- ============================================================================
-- ALTER TABLE: wallets — add Solana columns
-- Four new columns as specified in spec Section 11.
-- Using IF NOT EXISTS so re-running this migration is safe.
-- ============================================================================

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS solana_deposit_address TEXT,         -- Unique custodial deposit address per wallet
  ADD COLUMN IF NOT EXISTS solana_public_key       TEXT,        -- Agent's own Solana wallet (for sig verification, v2)
  ADD COLUMN IF NOT EXISTS solana_balance_usdc     NUMERIC(18,6), -- Display mirror of on-chain USDC balance
  ADD COLUMN IF NOT EXISTS last_solana_deposit_at  TIMESTAMPTZ; -- Timestamp of most recent confirmed deposit

-- Named constraint: deposit addresses must be unique per wallet (each wallet has its own escrow address).
-- We use DO $$ ... $$ block to guard against duplicate constraint errors on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'wallets'
    AND constraint_name = 'uq_wallets_solana_deposit_address'
  ) THEN
    ALTER TABLE wallets
      ADD CONSTRAINT uq_wallets_solana_deposit_address
        UNIQUE (solana_deposit_address);
  END IF;
END;
$$;

-- Index justification: deposit listener matches incoming webhook payload by deposit address
-- (memo field maps to wallet). This lookup happens on every Helius webhook delivery.
CREATE INDEX IF NOT EXISTS idx_wallets_solana_deposit_address
  ON wallets (solana_deposit_address)
  WHERE solana_deposit_address IS NOT NULL;

-- Index justification: ops queries show wallets with recent Solana activity; partial index
-- keeps it small (most wallets may never use Solana).
CREATE INDEX IF NOT EXISTS idx_wallets_last_solana_deposit
  ON wallets (last_solana_deposit_at DESC)
  WHERE last_solana_deposit_at IS NOT NULL;


-- ============================================================================
-- TABLE: solana_deposits
-- Immutable record of every confirmed USDC deposit received via Helius webhook.
-- tx_signature is the Solana transaction signature — globally unique on-chain.
-- It doubles as the idempotency key: inserting a duplicate tx_signature fails
-- with a unique violation (pg error 23505), signaling the webhook was already processed.
--
-- Depends on: wallets
-- ============================================================================
CREATE TABLE IF NOT EXISTS solana_deposits (
  id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  wallet_id       UUID         NOT NULL,
  tx_signature    TEXT         NOT NULL,          -- Solana transaction signature (base58, ~88 chars)
  amount_usdc     NUMERIC(18,6) NOT NULL,         -- USDC amount received (e.g. 25.000000)
  credits_issued  INTEGER      NOT NULL,          -- Credits credited to wallet (1 USDC = 40 credits)
  confirmed_at    TIMESTAMPTZ  NOT NULL,          -- Block confirmation timestamp (from Helius payload)
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),  -- When our backend processed it

  CONSTRAINT pk_solana_deposits PRIMARY KEY (id),
  CONSTRAINT fk_solana_deposits_wallet_id
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  CONSTRAINT uq_solana_deposits_tx_signature
    UNIQUE (tx_signature),                        -- PRIMARY idempotency key: Helius retries will fail here
  CONSTRAINT chk_solana_deposits_amount_positive
    CHECK (amount_usdc > 0),
  CONSTRAINT chk_solana_deposits_credits_positive
    CHECK (credits_issued > 0),
  CONSTRAINT chk_solana_deposits_minimum_deposit
    CHECK (amount_usdc >= 5)                      -- 5 USDC minimum floor (avoids dust deposits)
);

-- Index justification: wallet history endpoint queries deposits by wallet, ordered by recency.
CREATE INDEX IF NOT EXISTS idx_solana_deposits_wallet_created
  ON solana_deposits (wallet_id, created_at DESC);

-- Index justification: tx_signature lookup on webhook receipt must be instant —
-- idempotency check runs before any credit is issued.
-- (The UNIQUE constraint already creates an implicit B-tree index; this is redundant
--  but explicit for documentation purposes — the runner will see "already exists" and continue.)
-- Note: Supabase creates the unique index automatically; no separate CREATE INDEX needed.

-- Index justification: ops audit — find deposits in a date range for reconciliation.
CREATE INDEX IF NOT EXISTS idx_solana_deposits_confirmed_at
  ON solana_deposits (confirmed_at DESC);


-- ============================================================================
-- RPC: get_wallet_by_deposit_address
-- Resolves an incoming Solana deposit address to a wallet record.
-- Used by the Helius webhook handler to identify which user to credit.
-- Returns null if no wallet is associated with this deposit address.
-- ============================================================================
CREATE OR REPLACE FUNCTION get_wallet_by_deposit_address(
  p_deposit_address TEXT
)
RETURNS TABLE (
  wallet_id   UUID,
  user_id     UUID,
  balance     INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id          AS wallet_id,
    w.user_id,
    w.balance_credits AS balance
  FROM wallets w
  WHERE w.solana_deposit_address = p_deposit_address;
END;
$$;


-- ============================================================================
-- VERIFICATION QUERIES
--
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'wallets'
--   AND column_name IN ('solana_deposit_address','solana_public_key','solana_balance_usdc','last_solana_deposit_at')
--   ORDER BY column_name;
-- Expected: 4 rows
--
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'solana_deposits';
-- Expected: 1 row
--
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public' AND routine_name = 'get_wallet_by_deposit_address';
-- Expected: 1 row
-- ============================================================================

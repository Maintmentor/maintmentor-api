-- ============================================================================
-- ROLLBACK: 20260606_002_solana
-- Author:   Mack (CTO, MaintMentor.ai)
-- Date:     2026-06-06
-- Purpose:  Undo migration 20260606_002_solana.sql
--
-- SAFETY:   All statements use IF EXISTS — safe to run even if forward migration
--           partially failed or was never run.
-- ORDER:    Drop solana_deposits first (it FKs to wallets), then remove wallet columns.
-- WARNING:  Drops solana_deposits table and its data. Drops Solana columns from wallets.
--
-- Estimated rollback time: < 5 seconds on empty/small tables.
-- ============================================================================

-- Step 1: Drop RPC
DROP FUNCTION IF EXISTS get_wallet_by_deposit_address(TEXT);

-- Step 2: Drop solana_deposits table (FKs to wallets — must drop before removing wallet columns)
DROP TABLE IF EXISTS solana_deposits CASCADE;

-- Step 3: Drop indexes on wallets (they'll be auto-dropped with column removal,
-- but explicit drops are cleaner and prevent "index does not exist" errors on partial failures)
DROP INDEX IF EXISTS idx_wallets_solana_deposit_address;
DROP INDEX IF EXISTS idx_wallets_last_solana_deposit;

-- Step 4: Drop constraint on wallets (must drop before dropping the column)
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS uq_wallets_solana_deposit_address;

-- Step 5: Drop Solana columns from wallets
ALTER TABLE wallets DROP COLUMN IF EXISTS solana_deposit_address;
ALTER TABLE wallets DROP COLUMN IF EXISTS solana_public_key;
ALTER TABLE wallets DROP COLUMN IF EXISTS solana_balance_usdc;
ALTER TABLE wallets DROP COLUMN IF EXISTS last_solana_deposit_at;

-- ============================================================================
-- VERIFICATION: Run after rollback to confirm all objects are gone.
--
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'wallets'
--   AND column_name IN ('solana_deposit_address','solana_public_key','solana_balance_usdc','last_solana_deposit_at');
-- Expected: 0 rows
--
-- SELECT count(*) FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'solana_deposits';
-- Expected: 0
-- ============================================================================

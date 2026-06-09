-- ============================================================================
-- ROLLBACK: 001_agent_api_wallet
-- Author:   Mack (CTO, MaintMentor.ai)
-- Date:     2026-06-09
-- Purpose:  Undo 001_agent_api_wallet.sql
--
-- SAFETY:
--   - All statements use IF EXISTS — safe to run even if forward migration
--     partially failed or was never run.
--   - Drops in reverse dependency order (children before parents).
--
-- ⚠️  WARNING: THIS DESTROYS ALL DATA in the listed tables.
--     Only run on staging, or in production if you have a verified
--     point-in-time backup/snapshot.
--
-- Estimated rollback time: < 5 seconds on empty tables.
-- On production with live data: take a DB snapshot BEFORE running this.
-- ============================================================================

-- Step 1: Drop RLS policies (must drop before disabling RLS)
DROP POLICY IF EXISTS wallets_select_own             ON wallets;
DROP POLICY IF EXISTS wallets_insert_own             ON wallets;
DROP POLICY IF EXISTS wallets_update_own             ON wallets;
DROP POLICY IF EXISTS api_keys_select_own            ON api_keys;
DROP POLICY IF EXISTS api_keys_insert_own            ON api_keys;
DROP POLICY IF EXISTS api_keys_update_own            ON api_keys;
DROP POLICY IF EXISTS api_usage_logs_select_own      ON api_usage_logs;
DROP POLICY IF EXISTS wallet_transactions_select_own ON wallet_transactions;
DROP POLICY IF EXISTS credit_packs_select_authenticated ON credit_packs;

-- Step 2: Drop triggers (must drop before dropping the functions they call)
DROP TRIGGER IF EXISTS trg_wallets_negative_balance_guard ON wallets;
DROP TRIGGER IF EXISTS trg_wallets_updated_at             ON wallets;

-- Step 3: Drop RPC functions
DROP FUNCTION IF EXISTS alert_negative_balance();
DROP FUNCTION IF EXISTS credit_wallet(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS debit_wallet(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS trigger_set_updated_at();

-- Step 4: Drop tables in reverse FK dependency order
-- wallet_transactions references wallets + api_usage_logs → drop first
DROP TABLE IF EXISTS wallet_transactions CASCADE;

-- credit_packs has no FK dependencies → can drop at any time
DROP TABLE IF EXISTS credit_packs CASCADE;

-- api_usage_logs references api_keys + wallets → drop before both
DROP TABLE IF EXISTS api_usage_logs CASCADE;

-- api_keys references wallets → drop before wallets
DROP TABLE IF EXISTS api_keys CASCADE;

-- wallets is the root table → drop last
DROP TABLE IF EXISTS wallets CASCADE;

-- ============================================================================
-- VERIFICATION: Run after rollback to confirm all objects are gone.
--
-- SELECT count(*) FROM information_schema.tables
-- WHERE table_schema = 'public'
-- AND table_name IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs');
-- Expected: 0
--
-- SELECT count(*) FROM information_schema.routines
-- WHERE routine_schema = 'public'
-- AND routine_name IN ('debit_wallet','credit_wallet','trigger_set_updated_at','alert_negative_balance');
-- Expected: 0
--
-- SELECT count(*) FROM pg_policies
-- WHERE schemaname = 'public'
-- AND tablename IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs');
-- Expected: 0
-- ============================================================================

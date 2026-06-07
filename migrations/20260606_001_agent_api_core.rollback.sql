-- ============================================================================
-- ROLLBACK: 20260606_001_agent_api_core
-- Author:   Mack (CTO, MaintMentor.ai)
-- Date:     2026-06-06
-- Purpose:  Undo migration 20260606_001_agent_api_core.sql
--
-- SAFETY:   All statements use IF EXISTS — safe to run even if forward migration
--           partially failed or was never run.
-- ORDER:    Drop in reverse dependency order (children before parents).
-- WARNING:  This DESTROYS ALL DATA in the listed tables. Only run on staging,
--           or in production if you have a verified backup/snapshot.
--
-- Estimated rollback time: < 5 seconds on empty tables, longer with data.
-- ============================================================================

-- Step 1: Drop triggers (must drop before dropping the functions they depend on)
DROP TRIGGER IF EXISTS trg_wallets_negative_balance_guard ON wallets;
DROP TRIGGER IF EXISTS trg_wallets_updated_at ON wallets;

-- Step 2: Drop RPC functions
DROP FUNCTION IF EXISTS alert_negative_balance();
DROP FUNCTION IF EXISTS credit_wallet(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS debit_wallet(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS trigger_set_updated_at();

-- Step 3: Drop tables in reverse FK dependency order
-- wallet_transactions refs wallets + api_usage_logs → drop first
DROP TABLE IF EXISTS wallet_transactions CASCADE;

-- credit_packs is standalone → drop any time
DROP TABLE IF EXISTS credit_packs CASCADE;

-- api_usage_logs refs api_keys + wallets → drop before both
DROP TABLE IF EXISTS api_usage_logs CASCADE;

-- api_keys refs wallets → drop before wallets
DROP TABLE IF EXISTS api_keys CASCADE;

-- wallets is the root → drop last
DROP TABLE IF EXISTS wallets CASCADE;

-- ============================================================================
-- VERIFICATION: Run after rollback to confirm all objects are gone.
--
-- SELECT count(*) FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('wallets','api_keys','api_usage_logs','wallet_transactions','credit_packs');
-- Expected: 0
--
-- SELECT count(*) FROM information_schema.routines
--   WHERE routine_schema = 'public'
--   AND routine_name IN ('debit_wallet','credit_wallet','trigger_set_updated_at','alert_negative_balance');
-- Expected: 0
-- ============================================================================

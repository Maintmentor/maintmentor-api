-- ============================================================================
-- ROLLBACK: 20260606_003_data_flywheel
-- Author:   Mack (CTO, MaintMentor.ai)
-- Date:     2026-06-06
-- Purpose:  Undo migration 20260606_003_data_flywheel.sql
--
-- SAFETY:   All statements use IF EXISTS — safe to run even if forward migration
--           partially failed or was never run.
-- ORDER:    data_quality_flags and query_embeddings FK to query_history →
--           drop children before parent.
-- WARNING:  This DESTROYS ALL training data, embeddings, and quality flags.
--           DO NOT run against production unless you have verified backups.
--           The data flywheel is long-term institutional value.
--           Confirm with Dean (CEO) + Winston (COO) before running in prod.
--
-- Estimated rollback time: < 10 seconds on small tables.
--   On large datasets (1M+ rows), DROP TABLE may take 30–60 seconds
--   due to CASCADE deletes. Consider a maintenance window.
-- ============================================================================

-- Step 1: Drop RPC functions
DROP FUNCTION IF EXISTS purge_old_query_history();
DROP FUNCTION IF EXISTS get_feedback_stats(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS search_similar_queries(VECTOR(1536), FLOAT, INT);

-- Step 2: Drop tables in reverse FK dependency order
-- data_quality_flags FKs to query_history → drop first
DROP TABLE IF EXISTS data_quality_flags CASCADE;

-- query_embeddings FKs to query_history → drop before query_history
DROP TABLE IF EXISTS query_embeddings CASCADE;

-- query_history is the root → drop last
DROP TABLE IF EXISTS query_history CASCADE;

-- Step 3: Drop the vector extension
-- NOTE: Only drop this if NO OTHER tables use vector columns.
--       If you have other pgvector tables in this schema, comment out this line.
-- DROP EXTENSION IF EXISTS vector;
-- (Commented out by default — dropping an extension affects all tables that use it.)

-- ============================================================================
-- VERIFICATION: Run after rollback to confirm all objects are gone.
--
-- SELECT count(*) FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('query_history','query_embeddings','data_quality_flags');
-- Expected: 0
--
-- SELECT count(*) FROM information_schema.routines
--   WHERE routine_schema = 'public'
--   AND routine_name IN ('search_similar_queries','get_feedback_stats','purge_old_query_history');
-- Expected: 0
-- ============================================================================

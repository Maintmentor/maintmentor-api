-- =============================================================================
-- Migration: 20260612_004_maintenance_data_capture.sql
-- MaintMentor.ai — Maintenance Data Capture for AI Agent Training
-- Date: 2026-06-12
--
-- Steps:
--   1. Add columns to inspect_inspection_items
--   2. Add columns to query_history
--   3. Rebuild inspect_assets table with full schema
--   4. Create repair_outcomes table
--
-- Apply via: Supabase Dashboard → SQL Editor
-- =============================================================================

-- ── Step 1: Add columns to inspect_inspection_items ──────────────────────────
ALTER TABLE inspect_inspection_items 
  ADD COLUMN IF NOT EXISTS trade_category TEXT,
  ADD COLUMN IF NOT EXISTS equipment_age_years INTEGER,
  ADD COLUMN IF NOT EXISTS make_model TEXT,
  ADD COLUMN IF NOT EXISTS estimated_repair_cost NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS actual_repair_cost NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS urgency TEXT DEFAULT 'routine';

-- ── Step 2: Add columns to query_history ─────────────────────────────────────
ALTER TABLE query_history 
  ADD COLUMN IF NOT EXISTS trade_category TEXT,
  ADD COLUMN IF NOT EXISTS resolution_confirmed BOOLEAN,
  ADD COLUMN IF NOT EXISTS climate_region TEXT;

-- ── Step 3: Rebuild inspect_assets table ─────────────────────────────────────
-- Note: The existing inspect_assets table has a different schema.
-- We drop and rebuild to add trade_category, age_years (generated), 
-- condition, and other fields needed for AI training.
-- CAUTION: This will delete any existing data in inspect_assets.
DROP TABLE IF EXISTS inspect_assets CASCADE;

CREATE TABLE inspect_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES inspect_properties(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES inspect_units(id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL,                    -- HVAC / Water Heater / Electrical Panel / etc.
  trade_category TEXT NOT NULL,                -- HVAC / Electrical / Plumbing / Structural / General
  make TEXT,
  model TEXT,
  serial_number TEXT,
  install_date DATE,
  age_years INTEGER GENERATED ALWAYS AS (EXTRACT(YEAR FROM AGE(NOW(), install_date))::INTEGER) STORED,
  expected_lifespan_years INTEGER,
  last_service_date DATE,
  condition TEXT DEFAULT 'unknown',            -- good / fair / poor / failed
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Step 4: Create repair_outcomes table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS repair_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_item_id UUID REFERENCES inspect_inspection_items(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES inspect_assets(id) ON DELETE SET NULL,
  trade_category TEXT,
  repair_type TEXT,                            -- repair / replace / monitor / deferred
  contractor_type TEXT,                        -- in-house / vendor / tenant
  labor_hours NUMERIC(5,2),
  parts_cost NUMERIC(10,2),
  labor_cost NUMERIC(10,2),
  total_cost NUMERIC(10,2) GENERATED ALWAYS AS (COALESCE(parts_cost,0) + COALESCE(labor_cost,0)) STORED,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id),
  root_cause TEXT,
  prevention_notes TEXT,
  warranty_expiry DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Verification queries ──────────────────────────────────────────────────────
-- Run these to confirm migration worked:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'inspect_inspection_items' AND column_name IN ('trade_category','urgency','estimated_repair_cost') ORDER BY column_name;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'query_history' AND column_name IN ('trade_category','resolution_confirmed','climate_region') ORDER BY column_name;
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('inspect_assets','repair_outcomes') ORDER BY table_name;

-- ============================================================================
-- MaintMentor Security Controls — Database Migration
-- Run this against your Supabase database
-- ============================================================================

-- 1. Daily usage tracking (rate limits)
CREATE TABLE IF NOT EXISTS daily_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,  -- YYYY-MM-DD
  query_count INTEGER DEFAULT 0,
  photo_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_user_day ON daily_usage(user_id, day);

-- 2. Active sessions (concurrent session limits)
CREATE TABLE IF NOT EXISTS active_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_token TEXT NOT NULL,
  fingerprint TEXT,
  ip_address TEXT,
  user_agent TEXT,
  last_active TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, session_token)
);
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_token ON active_sessions(session_token);

-- 3. Device fingerprints
CREATE TABLE IF NOT EXISTS device_fingerprints (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_user ON device_fingerprints(user_id);

-- 4. Session geolocations
CREATE TABLE IF NOT EXISTS session_geolocations (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  ip_address TEXT,
  city TEXT,
  region TEXT,
  country TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  metro_area TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_geo_user ON session_geolocations(user_id);
CREATE INDEX IF NOT EXISTS idx_session_geo_seen ON session_geolocations(seen_at);

-- 5. Anomaly flags
CREATE TABLE IF NOT EXISTS anomaly_flags (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  reasons JSONB DEFAULT '[]',
  category TEXT,
  query_count_hour INTEGER,
  unique_trades JSONB DEFAULT '[]',
  active_hours DOUBLE PRECISION,
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  flagged_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anomaly_flags_user ON anomaly_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_flags_reviewed ON anomaly_flags(reviewed);

-- 6. Payment method tracking (deduplication)
CREATE TABLE IF NOT EXISTS payment_methods (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_payment_method_id TEXT,
  card_fingerprint TEXT,  -- Stripe card fingerprint for dedup
  card_last4 TEXT,
  card_brand TEXT,
  card_exp_month INTEGER,
  card_exp_year INTEGER,
  is_default BOOLEAN DEFAULT FALSE,
  flagged_duplicate BOOLEAN DEFAULT FALSE,
  duplicate_user_ids JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_fingerprint ON payment_methods(card_fingerprint);

-- 7. Phone verification tracking
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

-- 8. Conversation history access control (cancellation paywall)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS history_archived_at TIMESTAMPTZ;

-- 9. Helper function: increment daily query count atomically
CREATE OR REPLACE FUNCTION increment_daily_query(p_user_id TEXT, p_day TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO daily_usage (user_id, day, query_count, photo_count)
  VALUES (p_user_id, p_day, 1, 0)
  ON CONFLICT (user_id, day)
  DO UPDATE SET query_count = daily_usage.query_count + 1;
END;
$$ LANGUAGE plpgsql;

-- 10. Helper function: increment daily photo count atomically
CREATE OR REPLACE FUNCTION increment_daily_photo(p_user_id TEXT, p_day TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO daily_usage (user_id, day, query_count, photo_count)
  VALUES (p_user_id, p_day, 0, 1)
  ON CONFLICT (user_id, day)
  DO UPDATE SET photo_count = daily_usage.photo_count + 1;
END;
$$ LANGUAGE plpgsql;

-- 11. Payment method dedup check function
CREATE OR REPLACE FUNCTION check_card_duplicate(p_card_fingerprint TEXT, p_user_id TEXT)
RETURNS TABLE(is_duplicate BOOLEAN, existing_user_ids TEXT[]) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*) > 0 AS is_duplicate,
    ARRAY_AGG(DISTINCT pm.user_id) FILTER (WHERE pm.user_id != p_user_id) AS existing_user_ids
  FROM payment_methods pm
  WHERE pm.card_fingerprint = p_card_fingerprint
    AND pm.user_id != p_user_id;
END;
$$ LANGUAGE plpgsql;

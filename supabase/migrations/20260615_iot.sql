-- =============================================================
-- MaintMentor IoT Integration Schema
-- Run in Supabase SQL Editor: Dashboard → SQL Editor → New query
-- =============================================================

-- 1. Connected devices (one row per registered appliance)
CREATE TABLE IF NOT EXISTS iot_devices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform        text        NOT NULL,   -- 'ecobee' | 'nest' | 'smartthings' | 'matter'
  external_id     text        NOT NULL,   -- device ID from the platform
  device_type     text        NOT NULL,   -- 'thermostat' | 'hvac' | 'water_heater' | 'washer' etc.
  display_name    text,
  manufacturer    text,
  model           text,
  location        text,                   -- e.g. "Upstairs Hall", "Unit 4B"
  connected       boolean     DEFAULT true,
  last_seen_at    timestamptz,
  meta            jsonb       DEFAULT '{}',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(platform, external_id)
);

-- 2. Real-time device telemetry (runtime data, temps, humidity, etc.)
CREATE TABLE IF NOT EXISTS iot_telemetry (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid        NOT NULL REFERENCES iot_devices(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  data        jsonb       NOT NULL   -- flexible: {temp, humidity, runtime_mins, mode, ...}
);

-- 3. Fault events (error codes, alerts, anomalies)
CREATE TABLE IF NOT EXISTS iot_fault_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid        NOT NULL REFERENCES iot_devices(id) ON DELETE CASCADE,
  fault_code      text        NOT NULL,
  raw_description text,
  severity        text        DEFAULT 'warning',  -- 'info' | 'warning' | 'critical'
  ai_diagnosis    text,                           -- Winston's interpretation
  ai_steps        text,                           -- recommended action steps
  resolved        boolean     DEFAULT false,
  resolved_at     timestamptz,
  occurred_at     timestamptz DEFAULT now()
);

-- 4. OAuth tokens (encrypted at app level before storage)
CREATE TABLE IF NOT EXISTS iot_oauth_tokens (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform        text        NOT NULL,
  access_token    text        NOT NULL,
  refresh_token   text,
  expires_at      timestamptz,
  scope           text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(user_id, platform)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_iot_devices_user_id    ON iot_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_iot_devices_platform   ON iot_devices(platform);
CREATE INDEX IF NOT EXISTS idx_iot_telemetry_device   ON iot_telemetry(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_iot_faults_device      ON iot_fault_events(device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_iot_faults_unresolved  ON iot_fault_events(device_id) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_iot_tokens_user        ON iot_oauth_tokens(user_id, platform);

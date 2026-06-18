-- ============================================================
-- MaintMentor Property / IoT Schema
-- Migration: property-iot-schema.sql
-- Created: 2026-06-18
--
-- Tables:
--   properties          — buildings/complexes
--   units               — individual units within a property
--   assets              — appliances/equipment within a unit
--   user_property_access — techs/managers linked to properties
--   phone_unit_map      — tenant phone → unit (for WhatsApp routing)
-- ============================================================

-- ─── Properties ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                -- "Trimark - Gainesville Portfolio"
  address       TEXT,
  city          TEXT,
  state         TEXT DEFAULT 'FL',
  zip           TEXT,
  lat           DECIMAL(9,6),                -- GPS latitude
  lng           DECIMAL(9,6),                -- GPS longitude
  geofence_m    INTEGER DEFAULT 150,         -- geofence radius in meters
  property_type TEXT DEFAULT 'residential',  -- residential | commercial | mixed
  unit_count    INTEGER DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Units ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_number   TEXT NOT NULL,              -- "101", "2B", "Penthouse"
  floor         INTEGER,
  sqft          INTEGER,
  bedrooms      INTEGER,
  bathrooms     DECIMAL(3,1),
  tenant_name   TEXT,
  tenant_phone  TEXT,                       -- E.164 format +1...
  tenant_email  TEXT,
  move_in_date  DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(property_id, unit_number)
);

-- ─── Assets (Appliances / Equipment) ─────────────────────────
CREATE TABLE IF NOT EXISTS assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id         UUID REFERENCES units(id) ON DELETE CASCADE,
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,              -- "HVAC Unit", "Water Heater", "Range"
  asset_type      TEXT NOT NULL,              -- hvac|water_heater|electrical_panel|plumbing|appliance|sensor
  make            TEXT,
  model           TEXT,
  serial_number   TEXT,
  install_date    DATE,
  warranty_expiry DATE,
  location_desc   TEXT,                       -- "Roof unit 2A", "Utility closet"
  -- IoT fields
  iot_enabled     BOOLEAN DEFAULT FALSE,
  iot_device_id   TEXT UNIQUE,               -- MQTT client ID / device identifier
  iot_protocol    TEXT DEFAULT 'mqtt',        -- mqtt | http | modbus | bacnet
  iot_endpoint    TEXT,                       -- MQTT topic or HTTP endpoint
  iot_last_seen   TIMESTAMPTZ,
  iot_last_status JSONB,                      -- last telemetry payload
  -- QR
  qr_token        TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  -- Maintenance
  last_service_date DATE,
  next_service_date DATE,
  service_interval_days INTEGER DEFAULT 180,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── User ↔ Property Access ────────────────────────────────
CREATE TABLE IF NOT EXISTS user_property_access (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'technician', -- owner | manager | technician | viewer
  granted_by  UUID REFERENCES auth.users(id),
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,                        -- optional access expiry
  UNIQUE(user_id, property_id)
);

-- ─── Phone → Unit Map (tenant WhatsApp routing) ────────────
CREATE TABLE IF NOT EXISTS phone_unit_map (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL UNIQUE,              -- E.164 format
  unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label       TEXT,                              -- "Tenant", "Owner", "Manager"
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── IoT Events log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iot_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id),
  unit_id     UUID REFERENCES units(id),
  event_type  TEXT NOT NULL,                    -- alert | telemetry | status | error
  severity    TEXT DEFAULT 'info',              -- info | warning | critical | emergency
  payload     JSONB NOT NULL,                   -- raw device telemetry
  ai_diagnosis TEXT,                            -- MaintMentor AI response
  acknowledged BOOLEAN DEFAULT FALSE,
  ack_by      UUID REFERENCES auth.users(id),
  ack_at      TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);
CREATE INDEX IF NOT EXISTS idx_assets_unit ON assets(unit_id);
CREATE INDEX IF NOT EXISTS idx_assets_property ON assets(property_id);
CREATE INDEX IF NOT EXISTS idx_assets_qr_token ON assets(qr_token);
CREATE INDEX IF NOT EXISTS idx_assets_iot_device ON assets(iot_device_id);
CREATE INDEX IF NOT EXISTS idx_user_property ON user_property_access(user_id, property_id);
CREATE INDEX IF NOT EXISTS idx_phone_unit ON phone_unit_map(phone);
CREATE INDEX IF NOT EXISTS idx_iot_events_asset ON iot_events(asset_id);
CREATE INDEX IF NOT EXISTS idx_iot_events_property ON iot_events(property_id);
CREATE INDEX IF NOT EXISTS idx_iot_events_created ON iot_events(created_at DESC);

-- ─── Updated_at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_properties_updated BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_units_updated BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_assets_updated BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_property_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_unit_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_events ENABLE ROW LEVEL SECURITY;

-- Properties: visible to owner + anyone with access
CREATE POLICY prop_owner ON properties FOR ALL USING (owner_id = auth.uid());
CREATE POLICY prop_access ON properties FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_property_access WHERE user_id = auth.uid() AND property_id = properties.id)
);

-- Units: visible to property owner + access
CREATE POLICY unit_owner ON units FOR ALL USING (
  EXISTS (SELECT 1 FROM properties WHERE id = units.property_id AND owner_id = auth.uid())
);
CREATE POLICY unit_access ON units FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_property_access WHERE user_id = auth.uid() AND property_id = units.property_id)
);

-- Assets: same pattern
CREATE POLICY asset_owner ON assets FOR ALL USING (
  EXISTS (SELECT 1 FROM properties WHERE id = assets.property_id AND owner_id = auth.uid())
);
CREATE POLICY asset_access ON assets FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_property_access WHERE user_id = auth.uid() AND property_id = assets.property_id)
);

-- IoT events: property owner + tech access
CREATE POLICY iot_owner ON iot_events FOR ALL USING (
  EXISTS (SELECT 1 FROM properties WHERE id = iot_events.property_id AND owner_id = auth.uid())
);
CREATE POLICY iot_access ON iot_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_property_access WHERE user_id = auth.uid() AND property_id = iot_events.property_id)
);

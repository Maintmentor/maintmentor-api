-- ============================================================
-- Day 15 Growth Features Migration
-- MaintMentor Platform
-- Date: 2026-06-09
-- ============================================================

-- ─── teams table ─────────────────────────────────────────────────────────────
-- Lightweight alias for organizations; used by /api/teams REST endpoints.
-- The existing organizations table is the source of truth; this view-friendly
-- alias adds wallet_id for shared billing.

CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id   UUID REFERENCES wallets(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teams_owner_id_idx ON teams(owner_id);

-- ─── team_members table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_members_team_id_idx ON team_members(team_id);
CREATE INDEX IF NOT EXISTS team_members_user_id_idx ON team_members(user_id);

-- ─── referral_codes table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code             TEXT NOT NULL UNIQUE,
  credits_earned   INTEGER NOT NULL DEFAULT 0,
  referrals_count  INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)          -- one code per user
);

CREATE INDEX IF NOT EXISTS referral_codes_code_idx ON referral_codes(code);
CREATE INDEX IF NOT EXISTS referral_codes_user_id_idx ON referral_codes(user_id);

-- ─── user_alerts table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type  TEXT NOT NULL DEFAULT 'low_balance',
  threshold   NUMERIC NOT NULL DEFAULT 100,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_alerts_user_id_idx ON user_alerts(user_id);

-- ─── profiles table extensions ───────────────────────────────────────────────
-- Add referral_code column for quick lookup (mirrors referral_codes.code)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS profiles_referral_code_idx ON profiles(referral_code);

-- ─── Row Level Security ───────────────────────────────────────────────────────

-- teams: users can only see teams they own or belong to
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own teams" ON teams
  FOR SELECT USING (
    owner_id = auth.uid()
    OR id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create teams" ON teams
  FOR INSERT WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update their teams" ON teams
  FOR UPDATE USING (owner_id = auth.uid());

-- team_members: visible to team members
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view their team roster" ON team_members
  FOR SELECT USING (
    team_id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
    OR team_id IN (
      SELECT id FROM teams WHERE owner_id = auth.uid()
    )
  );

-- referral_codes: each user sees only their own
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own referral code" ON referral_codes
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own referral code" ON referral_codes
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- user_alerts: each user sees only their own
ALTER TABLE user_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own alerts" ON user_alerts
  FOR ALL USING (user_id = auth.uid());

-- ─── End of migration ─────────────────────────────────────────────────────────

-- ============================================================================
-- Full Database Setup for MaintMentor.ai — Supabase Migration
-- Step 1: Create all tables
-- Step 2: Add all RLS policies
-- Step 3: Seed data + triggers
-- ============================================================================

-- ===================== STEP 1: TABLES =====================

-- 1. Profiles
CREATE TABLE IF NOT EXISTS profiles (
  id                          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                       TEXT,
  full_name                   TEXT,
  phone                       TEXT,
  property_type               TEXT,
  number_of_beds              INT,
  bed_count                   INT DEFAULT 1,
  subscription_tier           TEXT DEFAULT 'trial',
  subscription_status         TEXT DEFAULT 'active',
  trial_ends_at               TIMESTAMPTZ,
  stripe_customer_id          TEXT,
  subscription_id             TEXT,
  subscription_plan           TEXT,
  subscription_ends_at        TIMESTAMPTZ,
  email_verified              BOOLEAN DEFAULT false,
  email_verified_at           TIMESTAMPTZ,
  verification_token          TEXT,
  verification_token_expires_at TIMESTAMPTZ,
  role                        TEXT DEFAULT 'user',
  org_id                      UUID,
  org_role                    TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Usage tracking
CREATE TABLE IF NOT EXISTS usage_tracking (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,
  query_count INT DEFAULT 0,
  photo_count INT DEFAULT 0,
  org_id      UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, month)
);

-- 3. User roles system
CREATE TABLE IF NOT EXISTS user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource    TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       UUID REFERENCES user_roles(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id     UUID REFERENCES user_roles(id) ON DELETE CASCADE,
  assigned_by UUID,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role_id)
);

-- 4. Contact submissions
CREATE TABLE IF NOT EXISTS contact_submissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  subject     TEXT,
  message     TEXT NOT NULL,
  status      TEXT DEFAULT 'new',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  billing_email TEXT NOT NULL,
  phone         TEXT,
  address       JSONB,
  plan_type     TEXT NOT NULL DEFAULT 'team',
  stripe_customer_id    TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  trial_ends_at TIMESTAMPTZ,
  subscription_status TEXT NOT NULL DEFAULT 'trialing',
  seat_count    INT NOT NULL DEFAULT 0,
  max_seats     INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_organizations_stripe_customer ON organizations(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- 6. Organization members
CREATE TABLE IF NOT EXISTS organization_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status      TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invited_email TEXT,
  invited_phone TEXT,
  invited_by  UUID REFERENCES auth.users(id),
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at   TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id),
  UNIQUE(org_id, invited_email)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_email ON organization_members(invited_email);

-- 7. Organization invites
CREATE TABLE IF NOT EXISTS organization_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_token ON organization_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_expires ON organization_invites(expires_at) WHERE accepted_at IS NULL;

-- Foreign keys from profiles/usage to organizations
ALTER TABLE profiles ADD CONSTRAINT fk_profiles_org FOREIGN KEY (org_id) REFERENCES organizations(id);
ALTER TABLE usage_tracking ADD CONSTRAINT fk_usage_org FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_usage_tracking_org ON usage_tracking(org_id, month);

-- ===================== STEP 2: RLS POLICIES =====================

-- Profiles RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Usage tracking RLS
ALTER TABLE usage_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own usage" ON usage_tracking FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own usage" ON usage_tracking FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own usage" ON usage_tracking FOR UPDATE USING (auth.uid() = user_id);

-- Roles RLS
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Roles viewable by authenticated" ON user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Permissions viewable by authenticated" ON permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Role permissions viewable by authenticated" ON role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can view own role assignments" ON user_role_assignments FOR SELECT USING (auth.uid() = user_id);

-- Contact submissions RLS
ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert contact submissions" ON contact_submissions FOR INSERT WITH CHECK (true);

-- Organizations RLS
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own org" ON organizations FOR SELECT
  USING (id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "Admins can update their org" ON organizations FOR UPDATE
  USING (id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND role = 'admin' AND status = 'active'));
CREATE POLICY "Authenticated users can create orgs" ON organizations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Organization members RLS
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view their org members" ON organization_members FOR SELECT
  USING (org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "Admins can insert members" ON organization_members FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND role = 'admin' AND status = 'active'));
CREATE POLICY "Admins can update members" ON organization_members FOR UPDATE
  USING (org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND role = 'admin' AND status = 'active'));
CREATE POLICY "Admins can remove members" ON organization_members FOR DELETE
  USING (org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND role = 'admin' AND status = 'active'));

-- Organization invites RLS
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read invite by token" ON organization_invites FOR SELECT USING (true);
CREATE POLICY "Admins can create invites" ON organization_invites FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid() AND role = 'admin' AND status = 'active'));

-- ===================== STEP 3: SEED DATA =====================

INSERT INTO user_roles (name, description) VALUES
  ('admin', 'Full system administrator with all permissions'),
  ('manager', 'Can manage users and view reports'),
  ('technician', 'Can create and manage repairs'),
  ('user', 'Standard user with basic access')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (resource, action) VALUES
  ('user_management', 'read'), ('user_management', 'write'), ('user_management', 'delete'), ('user_management', 'manage'),
  ('repairs', 'read'), ('repairs', 'write'), ('repairs', 'delete'), ('repairs', 'manage'),
  ('reports', 'read'), ('reports', 'write'), ('reports', 'export'),
  ('security_audit', 'read'), ('security_audit', 'write'),
  ('settings', 'read'), ('settings', 'write'), ('settings', 'manage'),
  ('ai_assistant', 'read'), ('ai_assistant', 'write'),
  ('notifications', 'read'), ('notifications', 'write'), ('notifications', 'manage')
ON CONFLICT DO NOTHING;

-- ===================== STEP 4: TRIGGER =====================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    now(),
    now()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

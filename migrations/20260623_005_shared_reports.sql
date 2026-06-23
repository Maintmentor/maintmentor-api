-- Migration: shared_reports table
-- Created: 2026-06-23
-- Purpose: Store shareable maintenance report links

CREATE TABLE IF NOT EXISTS shared_reports (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  token       text        UNIQUE NOT NULL,
  report_data jsonb       NOT NULL,
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz DEFAULT (now() + interval '30 days'),
  view_count  integer     DEFAULT 0
);

-- Index for fast token lookup
CREATE INDEX IF NOT EXISTS shared_reports_token_idx ON shared_reports (token);

-- Index for cleanup jobs
CREATE INDEX IF NOT EXISTS shared_reports_expires_at_idx ON shared_reports (expires_at);

-- Row-level security: public read by token (no auth required to view)
ALTER TABLE shared_reports ENABLE ROW LEVEL SECURITY;

-- Anyone can read a shared report (public link)
CREATE POLICY "shared_reports_public_read"
  ON shared_reports FOR SELECT
  USING (true);

-- Only service role can insert/update/delete (done via API)
CREATE POLICY "shared_reports_service_write"
  ON shared_reports FOR ALL
  USING (auth.role() = 'service_role');

-- Grant read to anon role for public access
GRANT SELECT ON shared_reports TO anon;

-- Optional: auto-delete expired reports (requires pg_cron or manual cleanup)
-- SELECT cron.schedule('cleanup-expired-reports', '0 2 * * *',
--   $$DELETE FROM shared_reports WHERE expires_at < now()$$);

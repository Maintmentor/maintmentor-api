/**
 * Team Analytics Module — MaintMentor API
 * Provides usage analytics for property manager dashboards.
 * Mack's build — Phase 1 for Gainesville property management demos.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function getUserFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  }
  const userId = req.body?.userId || req.query?.userId;
  if (userId) return { id: userId };
  return null;
}

async function isOrgAdmin(userId, orgId) {
  const { data } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .eq('status', 'active')
    .eq('role', 'admin')
    .maybeSingle();
  return !!data;
}

async function getUserOrgId(userId) {
  const { data } = await supabase
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return data;
}

// ─── Query Logging ─────────────────────────────────────────────────────────────

/**
 * Log a query to the query_log table.
 * Called from the chat endpoint after a successful response.
 */
async function logQuery({ userId, orgId, queryType, category, questionPreview }) {
  try {
    if (!userId) return;

    // If no orgId provided, look it up
    let finalOrgId = orgId;
    if (!finalOrgId) {
      const membership = await getUserOrgId(userId);
      finalOrgId = membership?.org_id || null;
    }

    await supabase.from('query_log').insert({
      user_id: userId,
      org_id: finalOrgId,
      query_type: queryType || 'chat',
      category: category || 'Other',
      question_preview: (questionPreview || '').substring(0, 120),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[team-analytics] logQuery error:', err.message);
  }
}

// ─── Ensure query_log table ────────────────────────────────────────────────────

async function ensureQueryLogTable() {
  try {
    const { error } = await supabase
      .from('query_log')
      .select('id')
      .limit(1);

    if (error && error.code === '42P01') {
      console.warn('[team-analytics] ⚠️  Table "query_log" does not exist.');
      console.warn('[team-analytics] Creating via SQL...');
      
      // Try to create it via rpc
      const { error: createErr } = await supabase.rpc('exec_sql', {
        sql: `
          CREATE TABLE IF NOT EXISTS query_log (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            org_id TEXT,
            query_type TEXT DEFAULT 'chat',
            category TEXT DEFAULT 'Other',
            question_preview TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_query_log_org ON query_log(org_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_query_log_user ON query_log(user_id, created_at DESC);
        `
      });
      
      if (createErr) {
        console.warn('[team-analytics] Could not auto-create table via rpc. Manual SQL needed:');
        console.warn(`
  CREATE TABLE IF NOT EXISTS query_log (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT,
    query_type TEXT DEFAULT 'chat',
    category TEXT DEFAULT 'Other',
    question_preview TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_query_log_org ON query_log(org_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_query_log_user ON query_log(user_id, created_at DESC);
        `);
      } else {
        console.log('[team-analytics] ✅ query_log table created');
      }
    } else if (error) {
      console.warn('[team-analytics] Table check warning:', error.message);
    } else {
      console.log('[team-analytics] ✅ query_log table accessible');
    }
  } catch (err) {
    console.warn('[team-analytics] Table check failed:', err.message);
  }
}

// ─── Route Registration ────────────────────────────────────────────────────────

function registerAnalyticsRoutes(app) {

  // GET /api/team/analytics?userId=...&orgId=...
  // Returns team usage stats, breakdowns per member
  app.get('/api/team/analytics', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const orgId = req.query.orgId;
      if (!orgId) return res.status(400).json({ success: false, error: 'orgId required' });

      // Verify user is admin
      const admin = await isOrgAdmin(user.id, orgId);
      if (!admin) return res.status(403).json({ success: false, error: 'Admin access required' });

      // Get org members
      const { data: members } = await supabase
        .from('organization_members')
        .select('user_id, role, status, invited_email')
        .eq('org_id', orgId)
        .eq('status', 'active');

      const memberIds = (members || []).map(m => m.user_id).filter(Boolean);

      if (memberIds.length === 0) {
        return res.json({
          success: true,
          teamStats: { totalQueries: 0, totalPhotos: 0, activeMembers: 0, avgQueriesPerMember: 0 },
          memberStats: [],
          dailyTrend: [],
          categoryBreakdown: [],
        });
      }

      // Get current month usage per member from usage_tracking
      const currentMonth = new Date().toISOString().slice(0, 7);
      const { data: usageRows } = await supabase
        .from('usage_tracking')
        .select('*')
        .in('user_id', memberIds)
        .eq('month', currentMonth);

      // Get query_log stats for last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Daily trend
      const { data: queryLogs } = await supabase
        .from('query_log')
        .select('user_id, query_type, category, created_at')
        .eq('org_id', orgId)
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: true });

      // Build daily trend
      const dailyMap = {};
      const categoryMap = {};
      const memberQueryMap = {};

      (queryLogs || []).forEach(log => {
        const day = log.created_at.slice(0, 10);
        dailyMap[day] = (dailyMap[day] || 0) + 1;

        const cat = log.category || 'Other';
        categoryMap[cat] = (categoryMap[cat] || 0) + 1;

        if (log.user_id) {
          if (!memberQueryMap[log.user_id]) memberQueryMap[log.user_id] = { total: 0, photos: 0 };
          memberQueryMap[log.user_id].total++;
          if (log.query_type === 'photo') memberQueryMap[log.user_id].photos++;
        }
      });

      // Build daily trend array for last 30 days
      const dailyTrend = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0, 10);
        dailyTrend.push({ date: key, queries: dailyMap[key] || 0 });
      }

      // Category breakdown
      const categoryBreakdown = Object.entries(categoryMap)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      // Per-member stats
      const memberStats = (members || []).map(m => {
        const usage = (usageRows || []).find(u => u.user_id === m.user_id);
        const logStats = memberQueryMap[m.user_id] || { total: 0, photos: 0 };

        // Also get week stats from query_log
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const weekQueries = (queryLogs || []).filter(
          l => l.user_id === m.user_id && l.created_at >= weekAgo
        ).length;

        return {
          userId: m.user_id,
          email: m.invited_email || m.user_id,
          role: m.role,
          monthlyQueries: usage?.query_count || 0,
          monthlyPhotos: usage?.photo_count || 0,
          last30DaysQueries: logStats.total,
          last30DaysPhotos: logStats.photos,
          weekQueries,
        };
      });

      // Team totals
      const totalQueries = memberStats.reduce((sum, m) => sum + m.monthlyQueries, 0);
      const totalPhotos = memberStats.reduce((sum, m) => sum + m.monthlyPhotos, 0);
      const activeMembers = memberStats.filter(m => m.monthlyQueries > 0).length;

      res.json({
        success: true,
        teamStats: {
          totalQueries,
          totalPhotos,
          activeMembers,
          totalMembers: memberStats.length,
          avgQueriesPerMember: memberStats.length > 0 ? Math.round(totalQueries / memberStats.length) : 0,
        },
        memberStats,
        dailyTrend,
        categoryBreakdown,
      });
    } catch (err) {
      console.error('[team-analytics] GET /api/team/analytics error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to load analytics' });
    }
  });

  // GET /api/team/activity?userId=...&orgId=...&limit=50&anonymized=false
  // Returns recent team activity feed
  app.get('/api/team/activity', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const orgId = req.query.orgId;
      if (!orgId) return res.status(400).json({ success: false, error: 'orgId required' });

      const admin = await isOrgAdmin(user.id, orgId);
      if (!admin) return res.status(403).json({ success: false, error: 'Admin access required' });

      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const anonymized = req.query.anonymized === 'true';

      const { data: logs, error } = await supabase
        .from('query_log')
        .select('id, user_id, query_type, category, question_preview, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      // Enrich with member info if not anonymized
      let memberMap = {};
      if (!anonymized && logs && logs.length > 0) {
        const userIds = [...new Set(logs.map(l => l.user_id))];
        const { data: members } = await supabase
          .from('organization_members')
          .select('user_id, invited_email')
          .eq('org_id', orgId)
          .in('user_id', userIds);
        
        (members || []).forEach(m => {
          memberMap[m.user_id] = m.invited_email || m.user_id;
        });
      }

      const activity = (logs || []).map((log, idx) => ({
        id: log.id,
        user: anonymized ? `Team Member ${(idx % 10) + 1}` : (memberMap[log.user_id] || 'Unknown'),
        userId: anonymized ? null : log.user_id,
        queryType: log.query_type,
        category: log.category,
        preview: log.question_preview,
        timestamp: log.created_at,
      }));

      res.json({ success: true, activity });
    } catch (err) {
      console.error('[team-analytics] GET /api/team/activity error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to load activity' });
    }
  });

  // GET /api/team/analytics/csv?userId=...&orgId=...
  // Monthly usage report as CSV
  app.get('/api/team/analytics/csv', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const orgId = req.query.orgId;
      if (!orgId) return res.status(400).json({ success: false, error: 'orgId required' });

      const admin = await isOrgAdmin(user.id, orgId);
      if (!admin) return res.status(403).json({ success: false, error: 'Admin access required' });

      const month = req.query.month || new Date().toISOString().slice(0, 7);

      // Get members
      const { data: members } = await supabase
        .from('organization_members')
        .select('user_id, role, invited_email')
        .eq('org_id', orgId)
        .eq('status', 'active');

      const memberIds = (members || []).map(m => m.user_id).filter(Boolean);

      // Get usage for the month
      const { data: usageRows } = await supabase
        .from('usage_tracking')
        .select('*')
        .in('user_id', memberIds)
        .eq('month', month);

      // Get query_log counts by category per user for the month
      const monthStart = `${month}-01T00:00:00.000Z`;
      const nextMonth = new Date(month + '-01');
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const monthEnd = nextMonth.toISOString();

      const { data: logs } = await supabase
        .from('query_log')
        .select('user_id, category, query_type')
        .eq('org_id', orgId)
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd);

      // Build per-user category breakdown
      const userCategories = {};
      (logs || []).forEach(l => {
        if (!userCategories[l.user_id]) userCategories[l.user_id] = {};
        const cat = l.category || 'Other';
        userCategories[l.user_id][cat] = (userCategories[l.user_id][cat] || 0) + 1;
      });

      // CSV
      const csvRows = ['Member Email,Role,Monthly Queries,Monthly Photos,Top Category,HVAC,Electrical,Plumbing,Appliance,Roofing,General,Other'];

      const allCategories = ['HVAC', 'Electrical', 'Plumbing', 'Appliance', 'Roofing', 'General', 'Other'];

      (members || []).forEach(m => {
        const usage = (usageRows || []).find(u => u.user_id === m.user_id);
        const cats = userCategories[m.user_id] || {};
        const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

        const catCounts = allCategories.map(c => cats[c] || 0);

        csvRows.push([
          m.invited_email || m.user_id,
          m.role,
          usage?.query_count || 0,
          usage?.photo_count || 0,
          topCat,
          ...catCounts,
        ].join(','));
      });

      const csv = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=maintmentor-usage-${month}.csv`);
      res.send(csv);
    } catch (err) {
      console.error('[team-analytics] CSV export error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to generate CSV' });
    }
  });
}

module.exports = { registerAnalyticsRoutes, logQuery, ensureQueryLogTable };

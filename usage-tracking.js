/**
 * Usage Tracking Module — MaintMentor API
 * Tracks per-user monthly usage against baseline limits.
 * Sterling's cost-visibility requirement.
 */

const { createClient } = require('@supabase/supabase-js');

// ─── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';

const QUERY_BASELINE = 200;   // AI diagnostic queries per month
const PHOTO_BASELINE = 50;    // Photo analyses per month
const OVERAGE_RATE = 0.05;    // $ per additional AI query

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers ───────────────────────────────────────────────────────────────────
function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Ensure a usage_tracking row exists for the given user+month.
 * Returns the current row.
 */
async function getOrCreateUsageRow(userId, month) {
  if (!userId) return null;

  const m = month || currentMonth();

  // Try to fetch existing row
  const { data: existing, error: fetchErr } = await supabase
    .from('usage_tracking')
    .select('*')
    .eq('user_id', userId)
    .eq('month', m)
    .maybeSingle();

  if (fetchErr) {
    console.error('[usage-tracking] fetch error:', fetchErr.message);
    return null;
  }

  if (existing) return existing;

  // Create new row
  const { data: created, error: insertErr } = await supabase
    .from('usage_tracking')
    .insert({
      user_id: userId,
      month: m,
      query_count: 0,
      photo_count: 0,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    // Race condition: another request may have created it
    if (insertErr.code === '23505') {
      const { data: retry } = await supabase
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .eq('month', m)
        .maybeSingle();
      return retry;
    }
    console.error('[usage-tracking] insert error:', insertErr.message);
    return null;
  }

  return created;
}

/**
 * Increment query_count for the user's current month.
 * Returns { overage: bool, overage_count: number, query_count: number }
 */
async function incrementQueryCount(userId) {
  if (!userId) return { overage: false, overage_count: 0, query_count: 0, tracked: false };

  const month = currentMonth();
  const row = await getOrCreateUsageRow(userId, month);
  if (!row) return { overage: false, overage_count: 0, query_count: 0, tracked: false };

  const newCount = (row.query_count || 0) + 1;

  const { error: updateErr } = await supabase
    .from('usage_tracking')
    .update({
      query_count: newCount,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('month', month);

  if (updateErr) {
    console.error('[usage-tracking] update error:', updateErr.message);
  }

  const overage = newCount > QUERY_BASELINE;
  const overage_count = overage ? newCount - QUERY_BASELINE : 0;

  return {
    overage,
    overage_count,
    query_count: newCount,
    photo_count: row.photo_count || 0,
    tracked: true,
  };
}

/**
 * Increment photo_count for the user's current month.
 */
async function incrementPhotoCount(userId) {
  if (!userId) return;

  const month = currentMonth();
  const row = await getOrCreateUsageRow(userId, month);
  if (!row) return;

  await supabase
    .from('usage_tracking')
    .update({
      photo_count: (row.photo_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('month', month);
}

/**
 * Get current month usage stats for a user.
 */
async function getUsageStats(userId) {
  const month = currentMonth();
  const row = await getOrCreateUsageRow(userId, month);

  if (!row) {
    return {
      user_id: userId,
      month,
      query_count: 0,
      photo_count: 0,
      query_baseline: QUERY_BASELINE,
      photo_baseline: PHOTO_BASELINE,
      query_remaining: QUERY_BASELINE,
      photo_remaining: PHOTO_BASELINE,
      overage: false,
      overage_count: 0,
      overage_cost: 0,
    };
  }

  const queryCount = row.query_count || 0;
  const photoCount = row.photo_count || 0;
  const overage = queryCount > QUERY_BASELINE;
  const overageCount = overage ? queryCount - QUERY_BASELINE : 0;

  return {
    user_id: userId,
    month,
    query_count: queryCount,
    photo_count: photoCount,
    query_baseline: QUERY_BASELINE,
    photo_baseline: PHOTO_BASELINE,
    query_remaining: Math.max(0, QUERY_BASELINE - queryCount),
    photo_remaining: Math.max(0, PHOTO_BASELINE - photoCount),
    overage,
    overage_count: overageCount,
    overage_cost: parseFloat((overageCount * OVERAGE_RATE).toFixed(2)),
    updated_at: row.updated_at,
  };
}

// ─── Express Routes ────────────────────────────────────────────────────────────
function registerUsageRoutes(app) {
  // GET /api/usage/:userId — current month usage stats
  app.get('/api/usage/:userId', async (req, res) => {
    try {
      const stats = await getUsageStats(req.params.userId);
      res.json({ success: true, ...stats });
    } catch (err) {
      console.error('[usage-tracking] GET /api/usage error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to retrieve usage stats' });
    }
  });
}

// ─── Ensure Supabase Table Exists ──────────────────────────────────────────────
async function ensureTable() {
  try {
    // Try a simple query to see if the table exists
    const { error } = await supabase
      .from('usage_tracking')
      .select('user_id')
      .limit(1);

    if (error && error.code === '42P01') {
      console.warn('[usage-tracking] ⚠️  Table "usage_tracking" does not exist. Creating via SQL...');
      // Attempt to create via rpc if available, otherwise log instructions
      console.warn('[usage-tracking] Please create the table manually:');
      console.warn(`
  CREATE TABLE IF NOT EXISTS usage_tracking (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    month TEXT NOT NULL,
    query_count INTEGER DEFAULT 0,
    photo_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, month)
  );
  CREATE INDEX idx_usage_user_month ON usage_tracking(user_id, month);
      `);
    } else if (error) {
      console.warn('[usage-tracking] Table check warning:', error.message);
    } else {
      console.log('[usage-tracking] ✅ usage_tracking table accessible');
    }
  } catch (err) {
    console.warn('[usage-tracking] Table check failed:', err.message);
  }
}

module.exports = {
  incrementQueryCount,
  incrementPhotoCount,
  getUsageStats,
  registerUsageRoutes,
  ensureTable,
  QUERY_BASELINE,
  PHOTO_BASELINE,
  OVERAGE_RATE,
};

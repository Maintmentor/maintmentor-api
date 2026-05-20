/**
 * Anomaly Detector — MaintMentor API (In-Memory)
 * Flags suspicious usage patterns:
 * - >15 queries/hour
 * - Queries spanning 3+ unrelated trades in one session
 * - >16 hours of active usage in a day
 * 
 * All tracking is in-memory. Logs to console (optionally to Supabase when tables exist).
 */

// In-memory tracking
const hourlyQueries = new Map(); // userId → { timestamps: [], categories: Set }
const dailyActivity = new Map(); // userId → { firstSeen: number, activeMinutes: Set }

const HOURLY_QUERY_THRESHOLD = 15;
const TRADE_DIVERSITY_THRESHOLD = 3;
const DAILY_ACTIVE_HOURS_THRESHOLD = 16;

// Optional Supabase for logging flags (non-blocking, best-effort)
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  // Fine — we'll just log to console
}

/**
 * Record a query and check for anomalies
 * Returns { flagged: bool, reasons: string[] }
 */
async function recordAndCheck(userId, category) {
  if (!userId) return { flagged: false, reasons: [] };

  const now = Date.now();
  const reasons = [];

  // ─── Hourly query rate ───
  if (!hourlyQueries.has(userId)) {
    hourlyQueries.set(userId, { timestamps: [], categories: new Set() });
  }
  const hourly = hourlyQueries.get(userId);
  hourly.timestamps.push(now);
  if (category) hourly.categories.add(category);

  // Trim to last hour
  const oneHourAgo = now - 60 * 60 * 1000;
  hourly.timestamps = hourly.timestamps.filter(t => t > oneHourAgo);

  if (hourly.timestamps.length > HOURLY_QUERY_THRESHOLD) {
    reasons.push(`High query rate: ${hourly.timestamps.length} queries in the last hour (threshold: ${HOURLY_QUERY_THRESHOLD})`);
  }

  // ─── Trade diversity ───
  if (hourly.categories.size >= TRADE_DIVERSITY_THRESHOLD) {
    reasons.push(`Multi-trade queries: ${hourly.categories.size} different trades in one session (${[...hourly.categories].join(', ')})`);
  }

  // ─── Daily active hours ───
  if (!dailyActivity.has(userId)) {
    dailyActivity.set(userId, { firstSeen: now, activeMinutes: new Set() });
  }
  const daily = dailyActivity.get(userId);

  const minuteBlock = Math.floor(now / (15 * 60 * 1000));
  daily.activeMinutes.add(minuteBlock);

  const activeHours = (daily.activeMinutes.size * 15) / 60;
  if (activeHours > DAILY_ACTIVE_HOURS_THRESHOLD) {
    reasons.push(`Excessive daily usage: ~${activeHours.toFixed(1)} active hours today (threshold: ${DAILY_ACTIVE_HOURS_THRESHOLD}h)`);
  }

  // ─── Log anomaly ───
  if (reasons.length > 0) {
    console.warn(`[anomaly] 🚩 User ${userId} flagged:`, reasons.join('; '));

    // Best-effort DB logging (non-blocking, swallow errors)
    if (supabase) {
      try {
        await supabase.from('anomaly_flags').insert({
          user_id: userId,
          reasons,
          category,
          query_count_hour: hourly.timestamps.length,
          unique_trades: [...hourly.categories],
          active_hours: activeHours,
          flagged_at: new Date().toISOString(),
        });
      } catch (e) {
        // Table may not exist yet — that's fine
      }
    }
  }

  return { flagged: reasons.length > 0, reasons };
}

// ─── Cleanup every hour ────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [userId, data] of hourlyQueries.entries()) {
    data.timestamps = data.timestamps.filter(t => t > cutoff);
    if (data.timestamps.length === 0) {
      hourlyQueries.delete(userId);
    }
  }

  // Reset daily tracking at midnight UTC
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
    dailyActivity.clear();
  }
}, 60 * 60 * 1000);

module.exports = { recordAndCheck };

/**
 * Rate Limiter — MaintMentor API (In-Memory Implementation)
 * 
 * Daily query caps:
 *   - Paid: 30/day
 *   - Trial days 1-3: 15/day
 *   - Trial days 4-7: 25/day
 * Daily photo caps:
 *   - Paid: 10/day
 *   - Trial: 3/day
 * Hourly cap: 20 queries/hour (extraction prevention)
 * 
 * Uses in-memory Maps. Fine for single-server; will migrate to DB later.
 */

// ─── Constants ──────────────────────────────────────────────────────────────────
const PAID_DAILY_QUERY_LIMIT = 50;
const PAID_DAILY_PHOTO_LIMIT = 20;
const TRIAL_DAILY_PHOTO_LIMIT = 10;
const HOURLY_QUERY_LIMIT = 30;

// Admin users get unlimited access
const ADMIN_USER_IDS = new Set([
  '3ae13ce5-b990-4cd3-8fa5-65da67804538', // Dean Richards (CEO)
]);

// ─── In-Memory Stores ──────────────────────────────────────────────────────────
// dailyUsage: userId → { day: 'YYYY-MM-DD', queryCount, photoCount }
const dailyUsage = new Map();
// hourlyUsage: userId → [timestamps]
const hourlyUsage = new Map();
// profileCache: userId → { subscription_status, created_at, cachedAt }
const profileCache = new Map();
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 min

// Optional Supabase for profile lookups (non-blocking)
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  console.warn('[rate-limiter] Supabase not available, running pure in-memory');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Gradual trial unlocking: day of trial → daily query limit
 */
function getTrialDailyLimit(trialDayNumber) {
  if (trialDayNumber <= 3) return 25;
  if (trialDayNumber <= 7) return 40;
  return 50; // After trial period, same as paid
}

/**
 * Get or create today's usage for a user (in-memory)
 */
function getDailyUsageEntry(userId) {
  const day = todayKey();
  let entry = dailyUsage.get(userId);
  if (!entry || entry.day !== day) {
    entry = { day, queryCount: 0, photoCount: 0 };
    dailyUsage.set(userId, entry);
  }
  return entry;
}

/**
 * Check hourly rate (extraction prevention)
 */
function checkHourlyRate(userId) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  
  let timestamps = hourlyUsage.get(userId) || [];
  timestamps = timestamps.filter(t => t > oneHourAgo);
  hourlyUsage.set(userId, timestamps);
  
  return {
    count: timestamps.length,
    allowed: timestamps.length < HOURLY_QUERY_LIMIT,
  };
}

/**
 * Try to get profile from Supabase (with cache)
 */
async function getUserProfile(userId) {
  if (!userId) return null;
  
  // Check cache
  const cached = profileCache.get(userId);
  if (cached && (Date.now() - cached.cachedAt) < PROFILE_CACHE_TTL) {
    return cached;
  }
  
  // Try Supabase
  if (supabase) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('subscription_status, subscription_tier, trial_ends_at, created_at, role')
        .eq('id', userId)
        .maybeSingle();
      
      if (data) {
        const profile = { ...data, cachedAt: Date.now() };
        profileCache.set(userId, profile);
        return profile;
      }
    } catch (err) {
      console.warn('[rate-limiter] Profile lookup failed (using defaults):', err.message);
    }
  }
  
  // Default: treat as trial user created today
  return { subscription_status: 'trial', created_at: new Date().toISOString(), cachedAt: Date.now() };
}

/**
 * Calculate trial day number
 */
function getTrialDay(profile) {
  if (!profile || !profile.created_at) return 1;
  const created = new Date(profile.created_at);
  const now = new Date();
  return Math.max(1, Math.ceil((now - created) / (1000 * 60 * 60 * 24)));
}

/**
 * Check if user is within daily + hourly rate limits
 */
// Guest/anonymous IP-based limits
const GUEST_DAILY_QUERY_LIMIT = 5;
const guestUsage = new Map(); // ip -> { day, queryCount }

function checkGuestLimit(ipAddress) {
  if (!ipAddress) return { allowed: false, reason: 'Unable to verify request origin.' };
  const day = todayKey();
  let entry = guestUsage.get(ipAddress);
  if (!entry || entry.day !== day) {
    entry = { day, queryCount: 0 };
    guestUsage.set(ipAddress, entry);
  }
  if (entry.queryCount >= GUEST_DAILY_QUERY_LIMIT) {
    return { allowed: false, reason: `You've used your ${GUEST_DAILY_QUERY_LIMIT} free questions for today. Sign up for a free trial to keep going!` };
  }
  entry.queryCount++;
  return { allowed: true };
}

async function checkDailyLimits(userId, isPhoto = false, ipAddress = null) {
  if (!userId) {
    return checkGuestLimit(ipAddress);
  }

  try {
    const usage = getDailyUsageEntry(userId);
    const profile = await getUserProfile(userId);

    // Admin bypass — unlimited access
    if (ADMIN_USER_IDS.has(userId) || profile?.role === 'admin') {
      return {
        allowed: true,
        queryCount: usage.queryCount,
        queryLimit: 999,
        photoCount: usage.photoCount,
        photoLimit: 999,
        admin: true,
      };
    }

    const isTrial = profile?.subscription_status === 'trial';
    const isExpired = profile?.subscription_status === 'expired';

    if (isExpired) {
      return {
        allowed: false,
        reason: 'Your trial has expired. Subscribe to continue using MaintMentor.',
        queryCount: usage.queryCount,
        queryLimit: 0,
        photoCount: usage.photoCount,
        photoLimit: 0,
      };
    }

    // Determine limits
    let queryLimit;
    let photoLimit;
    if (isTrial) {
      const trialDay = getTrialDay(profile);
      queryLimit = getTrialDailyLimit(trialDay);
      photoLimit = TRIAL_DAILY_PHOTO_LIMIT;
    } else {
      queryLimit = PAID_DAILY_QUERY_LIMIT;
      photoLimit = PAID_DAILY_PHOTO_LIMIT;
    }

    // ─── Hourly rate check (extraction prevention) ──────────────────────────
    const hourly = checkHourlyRate(userId);
    if (!hourly.allowed) {
      return {
        allowed: false,
        reason: `Slow down! You've asked ${hourly.count} questions in the last hour. Give it a few minutes and try again.`,
        queryCount: usage.queryCount,
        queryLimit,
        photoCount: usage.photoCount,
        photoLimit,
        hourlyLimited: true,
      };
    }

    // ─── Photo limit check ──────────────────────────────────────────────────
    if (isPhoto && usage.photoCount >= photoLimit) {
      return {
        allowed: false,
        reason: isTrial
          ? `Daily photo limit reached (${photoLimit}/day during trial). Subscribe for more photo analyses.`
          : `Daily photo limit reached (${photoLimit}/day). Resets at midnight UTC.`,
        queryCount: usage.queryCount,
        queryLimit,
        photoCount: usage.photoCount,
        photoLimit,
      };
    }

    // ─── Daily query limit check ────────────────────────────────────────────
    if (usage.queryCount >= queryLimit) {
      return {
        allowed: false,
        reason: isTrial
          ? `Daily trial limit reached (${queryLimit} queries/day). ${queryLimit < 25 ? 'Your limit increases as your trial progresses.' : ''} Subscribe for full access.`
          : `Daily query limit reached (${queryLimit}/day). Resets at midnight UTC.`,
        queryCount: usage.queryCount,
        queryLimit,
        photoCount: usage.photoCount,
        photoLimit,
      };
    }

    return {
      allowed: true,
      reason: 'ok',
      queryCount: usage.queryCount,
      queryLimit,
      photoCount: usage.photoCount,
      photoLimit,
    };
  } catch (err) {
    console.error('[rate-limiter] Error checking limits:', err.message);
    return { allowed: true, reason: 'ok', queryCount: 0, queryLimit: PAID_DAILY_QUERY_LIMIT, photoCount: 0, photoLimit: PAID_DAILY_PHOTO_LIMIT };
  }
}

/**
 * Increment daily query count + hourly timestamp
 */
async function incrementDailyQuery(userId) {
  if (!userId) return;
  const usage = getDailyUsageEntry(userId);
  usage.queryCount++;
  
  // Record hourly timestamp
  const timestamps = hourlyUsage.get(userId) || [];
  timestamps.push(Date.now());
  hourlyUsage.set(userId, timestamps);
}

/**
 * Increment daily photo count
 */
async function incrementDailyPhoto(userId) {
  if (!userId) return;
  const usage = getDailyUsageEntry(userId);
  usage.photoCount++;
}

// ─── Cleanup: reset daily at midnight UTC, trim hourly every 30 min ────────────
setInterval(() => {
  const today = todayKey();
  for (const [userId, entry] of dailyUsage.entries()) {
    if (entry.day !== today) {
      dailyUsage.delete(userId);
    }
  }
  
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [userId, timestamps] of hourlyUsage.entries()) {
    const filtered = timestamps.filter(t => t > oneHourAgo);
    if (filtered.length === 0) {
      hourlyUsage.delete(userId);
    } else {
      hourlyUsage.set(userId, filtered);
    }
  }
  
  // Expire stale profile cache entries
  const now = Date.now();
  for (const [userId, cached] of profileCache.entries()) {
    if (now - cached.cachedAt > PROFILE_CACHE_TTL * 2) {
      profileCache.delete(userId);
    }
  }
}, 30 * 60 * 1000);

module.exports = {
  checkDailyLimits,
  incrementDailyQuery,
  incrementDailyPhoto,
  getTrialDailyLimit,
  PAID_DAILY_QUERY_LIMIT,
  PAID_DAILY_PHOTO_LIMIT,
  TRIAL_DAILY_PHOTO_LIMIT,
  HOURLY_QUERY_LIMIT,
};

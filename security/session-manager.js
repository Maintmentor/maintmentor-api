/**
 * Session Manager — MaintMentor API (In-Memory Implementation)
 * 
 * Concurrent session limits:
 *   - Trial: 1 active session
 *   - Paid: 2 active sessions
 * 
 * Device fingerprint + IP tracking for anomaly detection.
 * Uses in-memory Maps. Will migrate to DB tables later.
 */

const TRIAL_SESSION_LIMIT = 1;
const PAID_SESSION_LIMIT = 2;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h inactivity = expired
const DEVICE_FLAG_THRESHOLD = 5;  // 5+ unique devices in 30 days
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 min

// ─── In-Memory Stores ──────────────────────────────────────────────────────────
// activeSessions: userId → Map<sessionToken, { fingerprint, ipAddress, userAgent, lastActive }>
const activeSessions = new Map();
// deviceHistory: userId → Map<fingerprint, lastSeen>
const deviceHistory = new Map();
// profileCache: userId → { subscription_status, cachedAt }
const profileCache = new Map();

// Optional Supabase for profile lookups
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  console.warn('[session-manager] Supabase not available, running pure in-memory');
}

/**
 * Get user profile (cached, with Supabase fallback)
 */
async function getUserProfile(userId) {
  if (!userId) return null;

  const cached = profileCache.get(userId);
  if (cached && (Date.now() - cached.cachedAt) < PROFILE_CACHE_TTL) {
    return cached;
  }

  if (supabase) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('subscription_status, subscription_tier')
        .eq('id', userId)
        .maybeSingle();

      if (data) {
        const profile = { ...data, cachedAt: Date.now() };
        profileCache.set(userId, profile);
        return profile;
      }
    } catch (err) {
      console.warn('[session-manager] Profile lookup failed:', err.message);
    }
  }

  return { subscription_status: 'trial', cachedAt: Date.now() };
}

/**
 * Clean expired sessions for a user
 */
function cleanExpiredSessions(userId) {
  const sessions = activeSessions.get(userId);
  if (!sessions) return;

  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [token, session] of sessions.entries()) {
    if (session.lastActive < cutoff) {
      sessions.delete(token);
    }
  }

  if (sessions.size === 0) {
    activeSessions.delete(userId);
  }
}

/**
 * Register a session. Enforces concurrent session limits.
 * If over limit, invalidates oldest session(s).
 */
async function registerSession(userId, sessionToken, fingerprint, ipAddress, userAgent) {
  if (!userId) return { allowed: true, invalidatedSessions: [], warning: null };

  try {
    const profile = await getUserProfile(userId);
    const isTrial = profile?.subscription_status === 'trial';
    const maxSessions = isTrial ? TRIAL_SESSION_LIMIT : PAID_SESSION_LIMIT;

    // Clean expired sessions first
    cleanExpiredSessions(userId);

    if (!activeSessions.has(userId)) {
      activeSessions.set(userId, new Map());
    }
    const sessions = activeSessions.get(userId);

    const invalidated = [];

    // If this token already exists, just update it
    if (sessions.has(sessionToken)) {
      sessions.set(sessionToken, {
        fingerprint: fingerprint || null,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
        lastActive: Date.now(),
      });
    } else {
      // New session — enforce limit
      while (sessions.size >= maxSessions) {
        // Find oldest session
        let oldestToken = null;
        let oldestTime = Infinity;
        for (const [tok, sess] of sessions.entries()) {
          if (sess.lastActive < oldestTime) {
            oldestTime = sess.lastActive;
            oldestToken = tok;
          }
        }
        if (oldestToken) {
          sessions.delete(oldestToken);
          invalidated.push(oldestToken);
        } else {
          break;
        }
      }

      // Register new session
      sessions.set(sessionToken, {
        fingerprint: fingerprint || null,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
        lastActive: Date.now(),
      });
    }

    // Track device fingerprint
    if (fingerprint) {
      trackDevice(userId, fingerprint);
    }

    return {
      allowed: true,
      invalidatedSessions: invalidated,
      warning: invalidated.length > 0
        ? 'Your account was signed in on another device. That session has been ended.'
        : null,
    };
  } catch (err) {
    console.error('[session-manager] Error:', err.message);
    return { allowed: true, invalidatedSessions: [], warning: null };
  }
}

/**
 * Check if a session token is still valid
 */
async function isSessionValid(userId, sessionToken) {
  if (!userId || !sessionToken) return true;

  const sessions = activeSessions.get(userId);
  if (!sessions) return false;

  const session = sessions.get(sessionToken);
  if (!session) return false;

  // Check TTL
  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    sessions.delete(sessionToken);
    return false;
  }

  return true;
}

/**
 * Refresh session activity timestamp
 */
async function refreshSession(userId, sessionToken) {
  if (!userId || !sessionToken) return;

  const sessions = activeSessions.get(userId);
  if (!sessions) return;

  const session = sessions.get(sessionToken);
  if (session) {
    session.lastActive = Date.now();
  }
}

/**
 * Track device fingerprints for anomaly detection
 */
function trackDevice(userId, fingerprint) {
  if (!deviceHistory.has(userId)) {
    deviceHistory.set(userId, new Map());
  }
  const devices = deviceHistory.get(userId);
  devices.set(fingerprint, Date.now());

  // Check threshold
  if (devices.size >= DEVICE_FLAG_THRESHOLD) {
    console.warn(`[session-manager] 🚩 User ${userId} has ${devices.size} unique devices`);
  }

  // Prune old entries (keep last 30 days)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [fp, lastSeen] of devices.entries()) {
    if (lastSeen < thirtyDaysAgo) {
      devices.delete(fp);
    }
  }
}

// ─── Cleanup interval: every hour, prune expired sessions ──────────────────────
setInterval(() => {
  for (const userId of activeSessions.keys()) {
    cleanExpiredSessions(userId);
  }

  // Prune stale profile cache
  const now = Date.now();
  for (const [userId, cached] of profileCache.entries()) {
    if (now - cached.cachedAt > PROFILE_CACHE_TTL * 6) {
      profileCache.delete(userId);
    }
  }
}, 60 * 60 * 1000);

module.exports = {
  registerSession,
  isSessionValid,
  refreshSession,
  TRIAL_SESSION_LIMIT,
  PAID_SESSION_LIMIT,
};

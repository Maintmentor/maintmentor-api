'use strict';

/**
 * lib/anomalyDetector.js
 *
 * Anomaly detection for MaintMentor Agent API billing.
 *
 * Runs as a periodic job (every 15 minutes via setInterval started in server.js).
 *
 * Why periodic job (not inline):
 *   - Keeps billing middleware fast — no synchronous anomaly logic in hot path
 *   - One scan covers all users at once (efficient)
 *   - Easier to test and disable independently
 *   - 15 min cadence is fast enough for all use cases here (no real-time SLA)
 *
 * Anomaly types detected:
 *   1. CREDIT_BURN_SPIKE  — last 1h credits > 3x user's 7-day hourly avg
 *   2. QUERY_VOLUME_SPIKE — last 1h queries > 3x user's 7-day hourly avg
 *   3. REPEATED_402       — ≥5 INSUFFICIENT_BALANCE responses in last 1h
 *   4. REPEATED_RATE_LIMIT — ≥10 429/rate-limit responses in last 1h
 *
 * Cooldown: one alert per user per anomaly type per hour.
 * Stored in anomaly_events table (created in Day 9 migration).
 */

const supabase = require('./supabase');
const logger   = require('./logger');

// ─── Constants ────────────────────────────────────────────────────────────────
const BURN_SPIKE_MULTIPLIER   = 3;   // 3x 7-day avg = anomaly
const VOLUME_SPIKE_MULTIPLIER = 3;
const REPEATED_402_THRESHOLD  = 5;   // 5+ 402s in 1h
const REPEATED_429_THRESHOLD  = 10;  // 10+ 429s in 1h
const COOLDOWN_HOURS          = 1;   // one alert per type per user per hour
const RESEND_FROM             = 'winston@maintmentor.ai';
const ALERT_TO                = 'dean@maintmentor.ai';

// ─── Email helper ─────────────────────────────────────────────────────────────

async function sendAnomalyAlert(userId, walletId, anomalyType, details) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    logger.warn({ anomalyType, userId }, 'RESEND_API_KEY not set — skipping anomaly alert email');
    return;
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(RESEND_API_KEY);

    const typeLabels = {
      CREDIT_BURN_SPIKE:    '🔥 Credit Burn Spike',
      QUERY_VOLUME_SPIKE:   '📈 Query Volume Spike',
      REPEATED_402:         '💸 Repeated Insufficient Balance Errors',
      REPEATED_RATE_LIMIT:  '⚡ Repeated Rate Limit Hits',
    };

    const label = typeLabels[anomalyType] || anomalyType;

    await resend.emails.send({
      from:    `MaintMentor Alerts <${RESEND_FROM}>`,
      to:      [ALERT_TO],
      subject: `[MaintMentor Alert] ${label} — User ${userId.slice(0, 8)}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#ef4444">⚠️ Anomaly Detected: ${label}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px;font-weight:bold;width:140px">User ID</td>
                <td style="padding:8px;font-family:monospace">${userId}</td></tr>
            <tr style="background:#f8fafc">
                <td style="padding:8px;font-weight:bold">Wallet ID</td>
                <td style="padding:8px;font-family:monospace">${walletId || 'unknown'}</td></tr>
            <tr><td style="padding:8px;font-weight:bold">Type</td>
                <td style="padding:8px">${anomalyType}</td></tr>
            <tr style="background:#f8fafc">
                <td style="padding:8px;font-weight:bold">Details</td>
                <td style="padding:8px"><pre style="margin:0;font-size:12px">${JSON.stringify(details, null, 2)}</pre></td></tr>
            <tr><td style="padding:8px;font-weight:bold">Detected at</td>
                <td style="padding:8px">${new Date().toISOString()}</td></tr>
          </table>
          <p style="color:#64748b;font-size:12px;margin-top:20px">
            This alert was sent because unusual API usage was detected.
            One alert per anomaly type per hour per user.
          </p>
        </div>
      `,
    });
    logger.info({ anomalyType, userId }, 'Anomaly alert email sent');
  } catch (err) {
    logger.error({ err: err.message, anomalyType, userId }, 'Failed to send anomaly alert email');
  }
}

// ─── Cooldown check ───────────────────────────────────────────────────────────

async function isOnCooldown(userId, anomalyType) {
  const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('anomaly_events')
    .select('id')
    .eq('user_id', userId)
    .eq('anomaly_type', anomalyType)
    .gte('detected_at', cutoff)
    .limit(1);

  if (error) {
    logger.warn({ err: error.message, userId, anomalyType }, 'Cooldown check failed — assuming no cooldown');
    return false; // fail open: allow alert
  }

  return data && data.length > 0;
}

// ─── Record anomaly event ─────────────────────────────────────────────────────

async function recordAnomalyEvent(userId, walletId, anomalyType, details) {
  const { error } = await supabase.from('anomaly_events').insert({
    user_id:      userId,
    wallet_id:    walletId,
    anomaly_type: anomalyType,
    details:      details,
    detected_at:  new Date().toISOString(),
    alerted:      true,
  });

  if (error) {
    logger.error({ err: error.message, userId, anomalyType }, 'Failed to record anomaly event');
  }
}

// ─── Anomaly detection logic ──────────────────────────────────────────────────

/**
 * Run all anomaly checks for a single wallet/user.
 *
 * @param {string} walletId
 * @param {string} userId
 * @param {Object[]} recentLogs - api_usage_logs rows from last 1h for this wallet
 * @param {Object[]} weekLogs   - api_usage_logs rows from last 7 days for this wallet
 */
async function checkWallet(walletId, userId, recentLogs, weekLogs) {
  const checks = [];

  // ── 1. Credit burn spike ──────────────────────────────────────────────────
  const recentCredits = recentLogs.reduce((s, l) => s + (l.credits_charged || 0), 0);
  // 7-day hourly avg: total credits in 7 days / 168 hours
  const weekCredits   = weekLogs.reduce((s, l) => s + (l.credits_charged || 0), 0);
  const weekHourlyAvg = weekCredits / 168; // 7 * 24

  if (weekHourlyAvg > 0 && recentCredits > weekHourlyAvg * BURN_SPIKE_MULTIPLIER) {
    checks.push({
      type: 'CREDIT_BURN_SPIKE',
      details: {
        last_1h_credits:    recentCredits,
        week_hourly_avg:    weekHourlyAvg.toFixed(2),
        spike_multiplier:   (recentCredits / weekHourlyAvg).toFixed(1),
        threshold:          BURN_SPIKE_MULTIPLIER,
      },
    });
  }

  // ── 2. Query volume spike ─────────────────────────────────────────────────
  const recentCalls = recentLogs.length;
  const weekHourlyCallAvg = weekLogs.length / 168;

  if (weekHourlyCallAvg > 0 && recentCalls > weekHourlyCallAvg * VOLUME_SPIKE_MULTIPLIER) {
    checks.push({
      type: 'QUERY_VOLUME_SPIKE',
      details: {
        last_1h_calls:       recentCalls,
        week_hourly_avg:     weekHourlyCallAvg.toFixed(2),
        spike_multiplier:    (recentCalls / weekHourlyCallAvg).toFixed(1),
        threshold:           VOLUME_SPIKE_MULTIPLIER,
      },
    });
  }

  // ── 3. Repeated 402 INSUFFICIENT_BALANCE ──────────────────────────────────
  const count402 = recentLogs.filter(l => l.response_status === 402).length;
  if (count402 >= REPEATED_402_THRESHOLD) {
    checks.push({
      type: 'REPEATED_402',
      details: { count_402_last_1h: count402, threshold: REPEATED_402_THRESHOLD },
    });
  }

  // ── 4. Repeated rate-limit hits ───────────────────────────────────────────
  const count429 = recentLogs.filter(l => l.response_status === 429).length;
  if (count429 >= REPEATED_429_THRESHOLD) {
    checks.push({
      type: 'REPEATED_RATE_LIMIT',
      details: { count_429_last_1h: count429, threshold: REPEATED_429_THRESHOLD },
    });
  }

  // ── Process triggered checks ───────────────────────────────────────────────
  for (const check of checks) {
    const onCooldown = await isOnCooldown(userId, check.type);
    if (!onCooldown) {
      logger.warn({ userId, walletId, anomalyType: check.type, details: check.details },
        `Anomaly detected: ${check.type}`);
      await recordAnomalyEvent(userId, walletId, check.type, check.details);
      await sendAnomalyAlert(userId, walletId, check.type, check.details);
    } else {
      logger.debug({ userId, anomalyType: check.type }, 'Anomaly on cooldown — skipping alert');
    }
  }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

/**
 * Scan all wallets for anomalies.
 * Called every 15 minutes by setInterval.
 */
async function runAnomalyScan() {
  const scanStart = Date.now();
  logger.info('Anomaly scan started');

  try {
    const now     = new Date();
    const hour1   = new Date(now - 1 * 60 * 60 * 1000).toISOString();
    const days7   = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all usage logs from the past 7 days (one query)
    const { data: weekData, error: weekErr } = await supabase
      .from('api_usage_logs')
      .select('wallet_id, credits_charged, response_status, created_at')
      .gte('created_at', days7)
      .order('created_at', { ascending: false });

    if (weekErr) {
      logger.error({ err: weekErr.message }, 'Anomaly scan: failed to fetch usage logs');
      return;
    }

    if (!weekData || weekData.length === 0) {
      logger.info({ duration_ms: Date.now() - scanStart }, 'Anomaly scan: no data to analyze');
      return;
    }

    // Group by wallet_id
    const byWallet = {};
    for (const row of weekData) {
      if (!row.wallet_id) continue;
      if (!byWallet[row.wallet_id]) {
        byWallet[row.wallet_id] = { week: [], recent: [] };
      }
      byWallet[row.wallet_id].week.push(row);
      if (row.created_at >= hour1) {
        byWallet[row.wallet_id].recent.push(row);
      }
    }

    // Fetch wallet → user_id mapping for wallets with activity
    const walletIds = Object.keys(byWallet);
    if (walletIds.length === 0) return;

    const { data: wallets, error: walletErr } = await supabase
      .from('wallets')
      .select('id, user_id')
      .in('id', walletIds);

    if (walletErr) {
      logger.error({ err: walletErr.message }, 'Anomaly scan: failed to fetch wallets');
      return;
    }

    const walletUserMap = {};
    for (const w of (wallets || [])) {
      walletUserMap[w.id] = w.user_id;
    }

    // Run checks per wallet
    let scanned = 0;
    for (const [walletId, { week, recent }] of Object.entries(byWallet)) {
      const userId = walletUserMap[walletId];
      if (!userId) continue;
      await checkWallet(walletId, userId, recent, week);
      scanned++;
    }

    logger.info({
      wallets_scanned: scanned,
      duration_ms: Date.now() - scanStart,
    }, 'Anomaly scan complete');

  } catch (err) {
    logger.error({ err: err.message }, 'Anomaly scan: unexpected error');
  }
}

/**
 * Start the periodic anomaly scan.
 * Call once on server startup.
 *
 * @param {number} intervalMs - default 15 minutes
 * @returns {NodeJS.Timeout} interval handle (for clearing in tests)
 */
function startAnomalyScan(intervalMs = 15 * 60 * 1000) {
  logger.info({ intervalMs }, 'Anomaly scanner started');
  // Run once immediately after 30s (let server fully start), then periodically
  const initial = setTimeout(runAnomalyScan, 30_000);
  const handle  = setInterval(runAnomalyScan, intervalMs);

  // Allow test env to skip the initial delay
  if (process.env.NODE_ENV === 'test') {
    clearTimeout(initial);
  }

  return handle;
}

module.exports = {
  startAnomalyScan,
  runAnomalyScan,
  // Export internals for testing
  _checkWallet:         checkWallet,
  _isOnCooldown:        isOnCooldown,
  _recordAnomalyEvent:  recordAnomalyEvent,
  BURN_SPIKE_MULTIPLIER,
  VOLUME_SPIKE_MULTIPLIER,
  REPEATED_402_THRESHOLD,
  REPEATED_429_THRESHOLD,
  COOLDOWN_HOURS,
};

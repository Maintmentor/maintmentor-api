/**
 * Spend Tracker — MaintMentor API
 * Track daily Claude API spend, warn at $10/day, hard-stop at $20/day.
 * Supports two-tier pricing (Sonnet + Haiku).
 */

const fs = require('fs');
const path = require('path');

// Model pricing (per token)
const MODEL_PRICING = {
  // Current models
  'claude-sonnet-4-6':         { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-haiku-4-5':          { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  'claude-haiku-4-5-20251001': { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  // Legacy (deprecated June 2026)
  'claude-sonnet-4-20250514':  { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};
const DEFAULT_PRICING = { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 };

// Legacy exports for compatibility
const INPUT_COST_PER_TOKEN = DEFAULT_PRICING.input;
const OUTPUT_COST_PER_TOKEN = DEFAULT_PRICING.output;

const DAILY_WARN_THRESHOLD = 10.00;  // $10/day warning
const DAILY_HARD_CAP = 20.00;        // $20/day hard stop

const SPEND_FILE = path.join(__dirname, '..', 'data', 'daily-spend.json');

// Ensure data directory exists
function ensureDataDir() {
  const dir = path.dirname(SPEND_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadSpendData() {
  ensureDataDir();
  try {
    if (fs.existsSync(SPEND_FILE)) {
      return JSON.parse(fs.readFileSync(SPEND_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[spend-tracker] Error loading spend data:', err.message);
  }
  return {};
}

function saveSpendData(data) {
  ensureDataDir();
  try {
    fs.writeFileSync(SPEND_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[spend-tracker] Error saving spend data:', err.message);
  }
}

/**
 * Get today's spend
 */
function getTodaySpend() {
  const data = loadSpendData();
  const today = todayKey();
  return data[today] || { totalCost: 0, requestCount: 0, inputTokens: 0, outputTokens: 0, warnings: [] };
}

/**
 * Check if spending is under the daily cap
 * Returns { allowed: bool, currentSpend: number, cap: number, warning: string|null }
 */
function checkSpendLimit() {
  const todayData = getTodaySpend();
  const currentSpend = todayData.totalCost || 0;

  if (currentSpend >= DAILY_HARD_CAP) {
    return {
      allowed: false,
      currentSpend,
      cap: DAILY_HARD_CAP,
      warning: `🚨 HARD CAP REACHED: Daily API spend is $${currentSpend.toFixed(2)} (cap: $${DAILY_HARD_CAP}). Service temporarily paused until midnight UTC.`,
    };
  }

  let warning = null;
  if (currentSpend >= DAILY_WARN_THRESHOLD) {
    warning = `⚠️ WARNING: Daily API spend is $${currentSpend.toFixed(2)} (cap: $${DAILY_HARD_CAP}). ${((currentSpend / DAILY_HARD_CAP) * 100).toFixed(0)}% of daily budget used.`;
  }

  return {
    allowed: true,
    currentSpend,
    cap: DAILY_HARD_CAP,
    warning,
  };
}

/**
 * Record API usage after a successful Claude call
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} [modelId] - model name for accurate pricing
 */
function recordSpend(inputTokens, outputTokens, modelId) {
  const pricing = (modelId && MODEL_PRICING[modelId]) || DEFAULT_PRICING;
  const inputCost = (inputTokens || 0) * pricing.input;
  const outputCost = (outputTokens || 0) * pricing.output;
  const totalCost = inputCost + outputCost;

  const data = loadSpendData();
  const today = todayKey();

  if (!data[today]) {
    data[today] = { totalCost: 0, requestCount: 0, inputTokens: 0, outputTokens: 0, warnings: [] };
  }

  data[today].totalCost += totalCost;
  data[today].requestCount += 1;
  data[today].inputTokens += (inputTokens || 0);
  data[today].outputTokens += (outputTokens || 0);

  // Log warnings
  if (data[today].totalCost >= DAILY_HARD_CAP && !data[today].warnings.includes('hard_cap')) {
    console.error(`🚨 [spend-tracker] HARD CAP REACHED: $${data[today].totalCost.toFixed(2)} / $${DAILY_HARD_CAP}`);
    data[today].warnings.push('hard_cap');
  } else if (data[today].totalCost >= DAILY_WARN_THRESHOLD && !data[today].warnings.includes('warn')) {
    console.warn(`⚠️ [spend-tracker] WARNING: Daily spend at $${data[today].totalCost.toFixed(2)} / $${DAILY_HARD_CAP}`);
    data[today].warnings.push('warn');
  }

  // Clean up old data (keep last 30 days)
  const keys = Object.keys(data).sort();
  while (keys.length > 30) {
    delete data[keys.shift()];
  }

  saveSpendData(data);

  return {
    requestCost: totalCost,
    dailyTotal: data[today].totalCost,
    dailyRequests: data[today].requestCount,
  };
}

/**
 * Get spend summary for admin endpoint
 */
function getSpendSummary() {
  const data = loadSpendData();
  const today = todayKey();
  const todayData = data[today] || { totalCost: 0, requestCount: 0, inputTokens: 0, outputTokens: 0 };
  
  // Last 7 days summary
  const last7 = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7.push({ date: key, ...(data[key] || { totalCost: 0, requestCount: 0 }) });
  }

  return {
    today: todayData,
    last7Days: last7,
    dailyWarnThreshold: DAILY_WARN_THRESHOLD,
    dailyHardCap: DAILY_HARD_CAP,
  };
}

module.exports = {
  checkSpendLimit,
  recordSpend,
  getSpendSummary,
  DAILY_WARN_THRESHOLD,
  DAILY_HARD_CAP,
};

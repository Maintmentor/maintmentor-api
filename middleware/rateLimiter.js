'use strict';

/**
 * middleware/rateLimiter.js
 *
 * Rate limiting middleware for MaintMentor agent API.
 *
 * Uses express-rate-limit with API key-based key generation.
 * Keys are per API key prefix — NOT per IP (agents share IPs).
 *
 * Two limiters:
 *   agentApiLimiter — 100 requests/minute per API key (general endpoints)
 *   photoLimiter    — 10 requests/minute per API key (photo endpoint)
 *
 * Key generation:
 *   Uses the API key prefix from req.apiContext (set by requireApiKey).
 *   Falls back to IP if prefix is not available (should not happen in normal flow).
 *
 * Error format matches MaintMentor API conventions:
 *   { error: "Rate limit exceeded", code: "RATE_LIMIT_EXCEEDED", retryAfter: N }
 */

const rateLimit = require('express-rate-limit');

// ─── Key Generator ─────────────────────────────────────────────────────────────
/**
 * Generate rate limit key from API key prefix.
 * Falls back to IP address if apiContext is not yet populated.
 *
 * @param {import('express').Request} req
 * @returns {string} Rate limit key
 */
function keyFromApiKey(req) {
  const prefix = req.apiContext?.apiKey?.prefix;
  if (prefix) return `key:${prefix}`;

  // Fallback to IP — requireApiKey should always run first
  const ip = req.headers['x-real-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
  return `ip:${ip}`;
}

// ─── Shared handler for rate limit exceeded responses ─────────────────────────
/**
 * Standard rate limit exceeded response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Object} options - express-rate-limit options
 */
function rateLimitHandler(req, res, _next, options) {
  const retryAfter = Math.ceil(options.windowMs / 1000);
  res.status(429).json({
    error: 'Rate limit exceeded',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter,
    message: `Too many requests. Limit: ${options.max} requests per ${retryAfter} seconds per API key.`,
  });
}

// ─── Rate Limit Review (Day 10 Go-Live) ──────────────────────────────────────
//
// VERDICT: Limits are appropriate for launch. Rationale:
//
//   agentApiLimiter — 100 req/min per API key
//     • A sustained 100 req/min = 6,000/hour = ~144,000/day for ONE key.
//     • At 5 credits each → max 720,000 credits/day/key.
//     • In practice, agents will use far less — this limit protects runaway loops.
//     • Competitors (OpenAI, Anthropic) allow 60–500 RPM on their lowest tiers.
//     • 100/min is generous enough for production use, tight enough to cap abuse.
//
//   photoLimiter — 10 req/min per API key
//     • Photos cost 3× more (15 credits) and hit Gemini Vision which is expensive.
//     • 10/min = 600/hour = sufficient for any real-world automation use case.
//     • Protects against accidental tight loops that could drain wallet rapidly.
//     • Can be relaxed for enterprise tier later via a higher-limit middleware.
//
// Both limits:
//   ✅ Key-based (not IP-based) — correct for shared-IP agent deployments
//   ✅ Standard RateLimit-* headers returned (client-friendly)
//   ✅ Consistent 429 JSON error format with retryAfter
//   ✅ No changes needed for launch.
//
// ─────────────────────────────────────────────────────────────────────────────

// ─── agentApiLimiter ───────────────────────────────────────────────────────────
/**
 * General agent API rate limiter.
 * 100 requests per minute per API key.
 */
const agentApiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 100,
  keyGenerator: keyFromApiKey,
  handler: rateLimitHandler,
  standardHeaders: true,   // Return RateLimit-* headers
  legacyHeaders: false,     // Disable X-RateLimit-* headers
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  message: {
    error: 'Rate limit exceeded',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

// ─── photoLimiter ──────────────────────────────────────────────────────────────
/**
 * Photo endpoint rate limiter.
 * More aggressive: 10 requests per minute per API key.
 * Photo analysis is expensive — protect against runaway costs.
 */
const photoLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,
  keyGenerator: keyFromApiKey,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  message: {
    error: 'Photo rate limit exceeded',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

module.exports = {
  agentApiLimiter,
  photoLimiter,
  keyFromApiKey,
};

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

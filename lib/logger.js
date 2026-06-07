'use strict';

/**
 * lib/logger.js
 *
 * Structured JSON logger for MaintMentor API.
 * Uses pino for production (JSON output) and pino-pretty for development.
 *
 * Usage:
 *   const logger = require('./lib/logger');
 *   logger.info({ route: '/api/health' }, 'Health check');
 *   logger.error({ err, userId }, 'Something failed');
 *
 * SECURITY:
 *   - Never log raw API keys, JWTs, or passwords
 *   - Sanitize request bodies before logging
 *   - userId is safe to log (UUID, not PII)
 */

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

const transport = isProd
  ? undefined // JSON to stdout in production
  : {
      target: 'pino-pretty',
      options: {
        colorize:     true,
        translateTime: 'HH:MM:ss.l',
        ignore:       'pid,hostname',
        singleLine:   false,
      },
    };

const logger = pino(
  {
    level:     process.env.LOG_LEVEL || 'info',
    base:      { service: 'maintmentor-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Redact sensitive fields at the pino level as a backstop
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        '*.key_hash',
        '*.password',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  },
  transport ? pino.transport(transport) : undefined,
);

// ─── Sanitize request metadata ──────────────────────────────────────────────
// Strip fields that must never appear in logs
const SENSITIVE_KEYS = new Set([
  'authorization', 'api_key', 'apikey', 'key_hash', 'token',
  'password', 'secret', 'stripe_secret', 'card', 'cvv', 'ssn',
]);

/**
 * Deep-sanitize an object, removing sensitive keys.
 * Used before logging request bodies or metadata.
 *
 * @param {Object} obj
 * @returns {Object}
 */
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

/**
 * Generate a request context object for structured logging.
 *
 * @param {import('express').Request} req
 * @returns {Object}
 */
function reqCtx(req) {
  return {
    requestId: req.id || req.headers['x-request-id'] || undefined,
    method:    req.method,
    route:     req.path,
    userId:    req.user?.id || req.apiContext?.apiKey?.user_id || undefined,
    ip:        req.ip,
  };
}

module.exports = logger;
module.exports.sanitize = sanitize;
module.exports.reqCtx   = reqCtx;

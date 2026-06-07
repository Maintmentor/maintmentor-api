'use strict';

/**
 * middleware/requestLogger.js
 *
 * Per-request structured logging middleware.
 * Attaches a requestId to each request and logs:
 *   - Incoming request (method, path, userId if available)
 *   - Outgoing response (status, latency_ms)
 *
 * Placed AFTER auth middleware so userId is available when possible.
 * Safe to place early in the chain — userId will be undefined for
 * unauthenticated routes, which is expected.
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../lib/logger');

/**
 * Attach requestId, log request, log response on finish.
 */
function requestLogger(req, res, next) {
  // Attach a unique request ID (use forwarded header if proxy sets it)
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('x-request-id', req.id);

  const startMs = Date.now();

  res.on('finish', () => {
    const latency = Date.now() - startMs;
    const level   = res.statusCode >= 500 ? 'error'
                  : res.statusCode >= 400 ? 'warn'
                  : 'info';

    logger[level]({
      requestId:  req.id,
      method:     req.method,
      route:      req.path,
      status:     res.statusCode,
      latency_ms: latency,
      userId:     req.user?.id || req.apiContext?.apiKey?.user_id || undefined,
    }, `${req.method} ${req.path} ${res.statusCode} ${latency}ms`);
  });

  next();
}

module.exports = requestLogger;

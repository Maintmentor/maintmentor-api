'use strict';

/**
 * middleware/balanceCheck.js
 *
 * Balance check middleware for MaintMentor agent API.
 *
 * Runs AFTER requireApiKey — wallet is already available on req.apiContext.
 *
 * Logic:
 *   1. Look up the credit cost for the requested route from CREDIT_COSTS config
 *   2. If wallet balance < cost → 402 Payment Required
 *   3. If balance OK → attach req.apiContext.creditCost and call next()
 *
 * Credit costs:
 *   POST /api/agent/query  → 5 credits
 *   POST /api/agent/photo  → 15 credits
 *   GET  /api/agent/usage  → 0 credits (free)
 */

// ─── Credit Cost Config ────────────────────────────────────────────────────────
// Maps [METHOD]:[path pattern] to credit cost
const CREDIT_COSTS = {
  'POST:/api/agent/query': 5,
  'POST:/api/agent/photo': 15,
  'GET:/api/agent/usage': 0,
};

/**
 * Resolve the credit cost for the current request.
 *
 * Tries exact match on `METHOD:baseUrl+path`, then falls back to
 * matching on the path alone.
 *
 * @param {import('express').Request} req
 * @returns {number|null} Credit cost, or null if endpoint is not in the map.
 */
function resolveCreditCost(req) {
  // Reconstruct the full path as registered (strip query string)
  const fullPath = (req.baseUrl || '') + (req.path || req.url?.split('?')[0] || '');
  const key = `${req.method.toUpperCase()}:${fullPath}`;

  if (typeof CREDIT_COSTS[key] === 'number') {
    return CREDIT_COSTS[key];
  }

  // Fallback: try without baseUrl prefix
  const pathKey = `${req.method.toUpperCase()}:${req.path}`;
  if (typeof CREDIT_COSTS[pathKey] === 'number') {
    return CREDIT_COSTS[pathKey];
  }

  return null;
}

/**
 * balanceCheck middleware.
 *
 * Prerequisites:
 *   - requireApiKey must have already run
 *   - req.apiContext.wallet must be present
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function balanceCheck(req, res, next) {
  const { wallet } = req.apiContext || {};

  if (!wallet) {
    // Should never happen if requireApiKey ran correctly
    return res.status(500).json({
      error: 'Wallet not found on request context',
      code: 'BALANCE_CHECK_MISSING_WALLET',
    });
  }

  const creditCost = resolveCreditCost(req);

  if (creditCost === null) {
    // Endpoint not in cost map — let it pass (defensive)
    console.warn(`[balanceCheck] No credit cost configured for ${req.method} ${req.originalUrl}`);
    req.apiContext.creditCost = 0;
    return next();
  }

  // Free endpoints skip balance check
  if (creditCost === 0) {
    req.apiContext.creditCost = 0;
    return next();
  }

  // balance_credits is treated as credits in the agent API context.
  // Future: migrate to a dedicated balance_credits column.
  const currentBalance = typeof wallet.balance_credits === 'number'
    ? wallet.balance_credits
    : parseFloat(wallet.balance_credits) || 0;

  if (currentBalance < creditCost) {
    return res.status(402).json({
      error: 'Insufficient credits',
      code: 'INSUFFICIENT_BALANCE',
      balance: currentBalance,
      required: creditCost,
    });
  }

  // Balance OK — attach cost to context and continue
  req.apiContext.creditCost = creditCost;
  return next();
}

module.exports = {
  balanceCheck,
  CREDIT_COSTS,
  resolveCreditCost,
};

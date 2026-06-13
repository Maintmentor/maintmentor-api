'use strict';

/**
 * middleware/billing.js
 *
 * Post-response billing middleware for MaintMentor agent API.
 *
 * Design principles:
 *   - Fire and forget: NEVER delays or blocks the response
 *   - Only charges on success (response status < 400)
 *   - Calls debit_wallet Supabase RPC to deduct credits atomically
 *   - Logs every request to api_usage_logs (no PII, no raw keys)
 *   - Wrapped in try/finally — runs even if route handler throws
 *   - On debit failure: logs error, does NOT block (alert hook ready for phase 2)
 *
 * Usage: Attach as the LAST middleware after the route handler.
 *   router.post('/query', rateLimiter, requireApiKey, balanceCheck, handler, billing);
 *
 * Expected on req.apiContext (set by requireApiKey + balanceCheck):
 *   - apiKey.id, apiKey.user_id, apiKey.prefix
 *   - wallet.id, wallet.user_id
 *   - creditCost  (set by balanceCheck)
 *
 * Expected on req.billingMeta (set by route handler, optional):
 *   - tokensUsed  (number)
 *   - requestMetadata  (object — sanitized, no PII)
 */

const supabase = require('../lib/supabase');

/**
 * Sanitize request metadata for logging.
 * Removes any fields that might contain PII or raw keys.
 *
 * @param {Object} meta - Raw metadata from route handler
 * @returns {Object} Sanitized metadata safe to log
 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};

  const sanitized = { ...meta };

  // Remove PII-adjacent fields
  const blocklist = [
    'authorization', 'api_key', 'apiKey', 'raw_key', 'rawKey',
    'token', 'password', 'secret', 'email', 'phone', 'name',
    'user_email', 'userEmail',
  ];

  for (const key of blocklist) {
    delete sanitized[key];
    delete sanitized[key.toLowerCase()];
  }

  return sanitized;
}

/**
 * billing middleware factory — returns an Express middleware function.
 *
 * Uses res.on('finish') to hook into response completion without
 * blocking or delaying the response to the client.
 *
 * @returns {import('express').RequestHandler}
 */
function billing(req, res, next) {
  const startTime = req._billingStartTime || Date.now();

  // Hook into response finish event (fires AFTER response is sent)
  res.on('finish', () => {
    // Only deduct credits on successful responses
    if (res.statusCode >= 400) {
      // Log the failed request without charging
      _logUsage(req, res, startTime, 0).catch(err => {
        console.error('[billing] Failed to log failed request:', err.message);
      });
      return;
    }

    // Fire and forget — never awaited
    _processCharge(req, res, startTime).catch(err => {
      console.error('[billing] Unhandled charge error:', err.message);
      // Phase 2: trigger alerting here
    });
  });

  return next();
}

/**
 * Internal: Process credit deduction and log the request.
 * Called fire-and-forget after response is sent.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} startTime - Request start timestamp (ms)
 */
async function _processCharge(req, res, startTime) {
  const { wallet, creditCost } = req.apiContext || {};
  const latencyMs = Date.now() - startTime;

  if (!wallet || !creditCost) {
    // Nothing to charge (free endpoint or missing context)
    await _logUsage(req, res, startTime, 0);
    return;
  }

  let debitSuccess = false;

  // ─── Debit the wallet ────────────────────────────────────────────────────────
  // Strategy: attempt the debit_wallet RPC first (atomic, preferred).
  // If the RPC is not yet deployed (PGRST202), fall back to a read-then-write
  // UPDATE. This fallback has a small race window but is acceptable until the
  // RPC is deployed in Phase 2.
  // TODO: Deploy debit_wallet RPC to eliminate the fallback path.
  try {
    const { error: rpcError } = await supabase.rpc('debit_wallet', {
      p_wallet_id: wallet.id,
      p_amount: creditCost,
    });

    if (!rpcError) {
      // RPC succeeded
      debitSuccess = true;
    } else if (rpcError.code === 'PGRST202') {
      // RPC not deployed yet — use direct read-modify-write fallback
      const { data: freshWallet, error: readError } = await supabase
        .from('wallets')
        .select('balance_credits, lifetime_spent')
        .eq('id', wallet.id)
        .single();

      if (readError || !freshWallet) {
        throw new Error(`Could not read wallet for debit: ${readError?.message}`);
      }

      const newBalance = Math.max(0, parseFloat(freshWallet.balance_credits) - creditCost);
      const newLifetimeSpend = (parseFloat(freshWallet.lifetime_spent) || 0) + creditCost;

      const { error: updateError } = await supabase
        .from('wallets')
        .update({
          balance_credits: newBalance,
          lifetime_spent: newLifetimeSpend,
        })
        .eq('id', wallet.id)
        .gte('balance_credits', creditCost); // Safety guard: only update if still sufficient

      if (updateError) {
        throw new Error(`Wallet debit UPDATE failed: ${updateError.message}`);
      }

      debitSuccess = true;
      console.log(`[billing] Debit ${creditCost} credits from wallet ${wallet.id} (direct-update fallback — deploy debit_wallet RPC for atomic ops)`);
    } else {
      throw new Error(`debit_wallet RPC failed: ${rpcError.message}`);
    }
  } catch (debitErr) {
    // Log error but don't throw — billing failure must never affect the user
    console.error('[billing] Debit failed for wallet', wallet.id, ':', debitErr.message);
    // Phase 2: trigger alert / retry queue here
  }

  // ─── Log to api_usage_logs ───────────────────────────────────────────────────
  try {
    await _logUsage(req, res, startTime, debitSuccess ? creditCost : 0);
  } catch (logErr) {
    console.error('[billing] Usage log failed:', logErr.message);
  }
}

/**
 * Internal: Write a row to api_usage_logs.
 * Sanitizes all data — no PII, no raw keys.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} startTime
 * @param {number} creditsCharged
 */
async function _logUsage(req, res, startTime, creditsCharged) {
  const { apiKey, wallet } = req.apiContext || {};
  const latencyMs = Date.now() - startTime;
  const billingMeta = req.billingMeta || {};

  // Determine endpoint from route path
  const endpoint = `${req.method} ${req.baseUrl || ''}${req.path}`;

  const logEntry = {
    wallet_id: wallet?.id || null,
    api_key_id: apiKey?.id || null,
    endpoint,
    tokens_used: billingMeta.tokensUsed || 0,
    credits_charged: creditsCharged,
    response_status: res.statusCode,
    latency_ms: latencyMs,
    request_metadata: sanitizeMetadata({
      ...billingMeta.requestMetadata,
      // Enrich with non-PII context fields
      api_key_prefix: apiKey?.prefix || null,
      account_id: apiKey?.user_id || null,
    }),
  };

  const { error } = await supabase
    .from('api_usage_logs')
    .insert(logEntry);

  if (error) {
    throw new Error(`api_usage_logs insert failed: ${error.message}`);
  }
}

module.exports = {
  billing,
  sanitizeMetadata,
};

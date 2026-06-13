'use strict';

/**
 * middleware/auth.js
 *
 * Authentication middleware for MaintMentor API.
 *
 * Two middleware functions:
 *
 * 1. requireJWT  — for dashboard routes (human users)
 *    Verifies Supabase JWT from Bearer token.
 *    Attaches decoded user to req.user.
 *
 * 2. requireApiKey — for agent/developer API routes
 *    Validates mm_pk_* Bearer tokens against hashed keys in Supabase.
 *    Attaches { apiKey, wallet } to req.apiContext.
 *    Updates last_used_at asynchronously (fire and forget).
 */

const supabase = require('../lib/supabase');
const { hashApiKey, validateKeyFormat } = require('../lib/apiKeys');

// ─── requireJWT ─────────────────────────────────────────────────────────────────

/**
 * Middleware: Verify Supabase JWT for dashboard (human user) routes.
 *
 * Extracts Bearer token from Authorization header, verifies it with
 * the Supabase admin client (getUser), and attaches the decoded user
 * to req.user.
 *
 * Returns 401 if token is missing, invalid, or expired.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireJWT(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or invalid Authorization header',
      code: 'AUTH_MISSING_TOKEN',
    });
  }

  const token = authHeader.slice(7); // strip "Bearer "

  if (!token) {
    return res.status(401).json({
      error: 'Empty token',
      code: 'AUTH_EMPTY_TOKEN',
    });
  }

  try {
    // Verify JWT using Supabase admin client
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'AUTH_INVALID_TOKEN',
      });
    }

    // Attach the verified user to the request
    req.user = data.user;
    return next();
  } catch (err) {
    console.error('requireJWT error:', err.message);
    return res.status(401).json({
      error: 'Token verification failed',
      code: 'AUTH_VERIFY_FAILED',
    });
  }
}

// ─── requireApiKey ───────────────────────────────────────────────────────────────

/**
 * Middleware: Validate mm_pk_* API key for agent/developer API routes.
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header
 *   2. Validate format (mm_pk_<32 hex>)
 *   3. SHA-256 hash the token
 *   4. Look up hash in api_keys table
 *   5. Verify is_active = true
 *   6. Load associated wallet
 *   7. Attach { apiKey, wallet } to req.apiContext
 *   8. Fire-and-forget: update last_used_at
 *
 * Returns 401 if key is missing, invalid format, not found, or revoked.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireApiKey(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or invalid Authorization header',
      code: 'AUTH_MISSING_TOKEN',
    });
  }

  const rawKey = authHeader.slice(7); // strip "Bearer "

  // Validate key format before touching the database
  if (!validateKeyFormat(rawKey)) {
    return res.status(401).json({
      error: 'Invalid API key format',
      code: 'AUTH_INVALID_KEY_FORMAT',
    });
  }

  // Hash the key — we never store the raw key
  const keyHash = hashApiKey(rawKey);

  try {
    // Look up the hashed key in the database
    const { data: apiKey, error: keyError } = await supabase
      .from('api_keys')
      .select('id, user_id, is_active, label, key_prefix')
      .eq('key_hash', keyHash)
      .single();

    if (keyError || !apiKey) {
      return res.status(401).json({
        error: 'Invalid API key',
        code: 'AUTH_KEY_NOT_FOUND',
      });
    }

    // Check key is still active (not revoked)
    if (!apiKey.is_active) {
      return res.status(401).json({
        error: 'API key has been revoked',
        code: 'AUTH_KEY_REVOKED',
      });
    }

    // Load associated wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, user_id, balance_credits, lifetime_credits, lifetime_spent')
      .eq('user_id', apiKey.user_id)
      .single();

    if (walletError || !wallet) {
      return res.status(401).json({
        error: 'Wallet not found for API key owner',
        code: 'AUTH_WALLET_NOT_FOUND',
      });
    }

    // Attach context to request
    req.apiContext = {
      apiKey: {
        id: apiKey.id,
        user_id: apiKey.user_id,
        prefix: apiKey.key_prefix,
        label: apiKey.label,
      },
      wallet,
    };

    // Fire-and-forget: update last_used_at (don't await — don't block the request)
    supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', apiKey.id)
      .then(({ error }) => {
        if (error) {
          console.error('Failed to update last_used_at for key', apiKey.id, ':', error.message);
        }
      });

    return next();
  } catch (err) {
    console.error('requireApiKey error:', err.message);
    return res.status(401).json({
      error: 'API key verification failed',
      code: 'AUTH_VERIFY_FAILED',
    });
  }
}

module.exports = {
  requireJWT,
  requireApiKey,
};

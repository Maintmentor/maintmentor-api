'use strict';

/**
 * routes/dashboard.js
 *
 * Dashboard API routes for managing API keys and wallet information.
 * All routes require valid Supabase JWT authentication (requireJWT middleware).
 *
 * Route prefix: /api/dashboard  (registered in server.js)
 *
 * Endpoints:
 *   POST   /keys              - Generate a new API key
 *   GET    /keys              - List all API keys for the authenticated user
 *   DELETE /keys/:id          - Revoke an API key
 *   GET    /wallet            - Get wallet balance and recent transactions
 *   GET    /wallet/packs      - List available credit packs
 *   POST   /wallet/topup      - Create Stripe Checkout session for credit pack purchase
 */

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { requireJWT } = require('../middleware/auth');
const { generateApiKey, hashApiKey, getKeyPrefix } = require('../lib/apiKeys');
const { getOrCreateWallet } = require('../lib/wallet');
const { stripe, getActiveCreditPacks, getCreditPackById } = require('../lib/stripe');

// ─── POST /keys ─────────────────────────────────────────────────────────────────
/**
 * Create a new API key for the authenticated user.
 *
 * Request body (optional):
 *   { label: string }
 *
 * Response:
 *   201 { key, prefix, label, created_at }
 *
 * SECURITY: The raw key is returned ONCE in this response.
 * It is NEVER stored in the database and NEVER logged.
 */
router.post('/keys', async (req, res) => {
  const userId = req.user.id;
  const label = req.body?.label || null;

  try {
    // Ensure wallet exists
    await getOrCreateWallet(userId);

    // Generate raw key — will be returned once and never stored
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const prefix = getKeyPrefix(rawKey);

    // Insert into api_keys — store ONLY hash + prefix, never raw key
    const { data: apiKey, error } = await supabase
      .from('api_keys')
      .insert({
        user_id: userId,
        key_hash: keyHash,
        key_prefix: prefix,
        label: label,
        is_active: true,
      })
      .select('id, key_prefix, label, is_active, created_at')
      .single();

    if (error) {
      console.error('Failed to insert api_key:', error.message);
      return res.status(500).json({
        error: 'Failed to create API key',
        code: 'KEY_CREATE_FAILED',
      });
    }

    // Return the raw key ONCE — this is the only time it will ever appear
    return res.status(201).json({
      key: rawKey,              // ← show once, never store
      prefix: apiKey.key_prefix,
      label: apiKey.label,
      created_at: apiKey.created_at,
    });
  } catch (err) {
    console.error('POST /dashboard/keys error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /keys ──────────────────────────────────────────────────────────────────
/**
 * List all API keys for the authenticated user.
 * Returns metadata only — NEVER the key_hash.
 *
 * Response:
 *   200 { keys: [{ id, prefix, label, is_active, last_used_at, created_at }] }
 */
router.get('/keys', async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: keys, error } = await supabase
      .from('api_keys')
      .select('id, key_prefix, label, is_active, last_used_at, created_at, revoked_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to list api_keys:', error.message);
      return res.status(500).json({
        error: 'Failed to retrieve API keys',
        code: 'KEY_FETCH_FAILED',
      });
    }

    // Explicitly exclude key_hash from response — it should not be in the query
    // above, but this ensures it never leaks even if schema changes
    const safeKeys = (keys || []).map(({ id, key_prefix, label, is_active, last_used_at, created_at, revoked_at }) => ({
      id,
      prefix: key_prefix,
      label,
      is_active,
      last_used_at,
      created_at,
      revoked_at,
    }));

    return res.status(200).json({ keys: safeKeys });
  } catch (err) {
    console.error('GET /dashboard/keys error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── DELETE /keys/:id ───────────────────────────────────────────────────────────
/**
 * Revoke an API key by ID.
 * Sets is_active = false and revoked_at = NOW().
 * Only revokes keys that belong to the authenticated user.
 *
 * Response:
 *   204 (no body)
 *   404 if key not found or doesn't belong to user
 */
router.delete('/keys/:id', async (req, res) => {
  const userId = req.user.id;
  const keyId = req.params.id;

  if (!keyId) {
    return res.status(400).json({
      error: 'Key ID is required',
      code: 'MISSING_KEY_ID',
    });
  }

  try {
    // Verify key exists AND belongs to this user before revoking
    const { data: existing, error: fetchError } = await supabase
      .from('api_keys')
      .select('id, is_active')
      .eq('id', keyId)
      .eq('user_id', userId)  // ownership check
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        error: 'API key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    if (!existing.is_active) {
      // Already revoked — idempotent success
      return res.status(204).send();
    }

    // Revoke: mark inactive and set revoked_at timestamp
    const { error: updateError } = await supabase
      .from('api_keys')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
      })
      .eq('id', keyId)
      .eq('user_id', userId);  // belt-and-suspenders ownership check

    if (updateError) {
      console.error('Failed to revoke api_key:', updateError.message);
      return res.status(500).json({
        error: 'Failed to revoke API key',
        code: 'KEY_REVOKE_FAILED',
      });
    }

    return res.status(204).send();
  } catch (err) {
    console.error('DELETE /dashboard/keys/:id error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /wallet ─────────────────────────────────────────────────────────────────
/**
 * Get wallet balance, lifetime stats, and last 20 transactions
 * for the authenticated user.
 *
 * Response:
 *   200 { wallet: { id, balance_usd, lifetime_queries, lifetime_spend_usd, ... }, transactions: [...] }
 *   404 if no wallet exists yet
 */
router.get('/wallet', async (req, res) => {
  const userId = req.user.id;

  try {
    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, balance_usd, lifetime_queries, lifetime_spend_usd, created_at, updated_at')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      if (walletError.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Wallet not found — no API keys have been created yet',
          code: 'WALLET_NOT_FOUND',
        });
      }
      console.error('Failed to fetch wallet:', walletError.message);
      return res.status(500).json({
        error: 'Failed to retrieve wallet',
        code: 'WALLET_FETCH_FAILED',
      });
    }

    // Fetch last 20 transactions
    const { data: transactions, error: txError } = await supabase
      .from('wallet_transactions')
      .select('id, amount_usd, type, description, created_at, metadata')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (txError) {
      console.error('Failed to fetch wallet transactions:', txError.message);
      // Return wallet data even if transactions fail
      return res.status(200).json({
        wallet,
        transactions: [],
        transactions_warning: 'Failed to load transaction history',
      });
    }

    return res.status(200).json({
      wallet,
      transactions: transactions || [],
    });
  } catch (err) {
    console.error('GET /dashboard/wallet error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /wallet/packs ──────────────────────────────────────────────────────────
/**
 * List all active credit packs available for purchase.
 *
 * Response:
 *   200 { packs: [{ id, name, credits, price_usd, description }] }
 */
router.get('/wallet/packs', async (req, res) => {
  try {
    const packs = await getActiveCreditPacks();
    return res.status(200).json({ packs });
  } catch (err) {
    console.error('GET /dashboard/wallet/packs error:', err.message);
    return res.status(500).json({
      error: 'Failed to retrieve credit packs',
      code: 'PACKS_FETCH_FAILED',
    });
  }
});

// ─── POST /wallet/topup ──────────────────────────────────────────────────────────
/**
 * Create a Stripe Checkout session to purchase a credit pack.
 *
 * Request body:
 *   { pack_id: "uuid" }  — ID of the credit pack to purchase
 *
 * Response:
 *   200 { checkout_url: "https://checkout.stripe.com/..." }
 *   400 if pack_id is missing
 *   404 if pack is not found or inactive
 *   500 on Stripe or DB error
 *
 * Flow:
 *   1. Validate pack_id → load active pack from credit_packs
 *   2. Get or create Stripe customer (cached in wallets.stripe_customer_id)
 *   3. Create Stripe Checkout Session (one-time payment)
 *   4. Return checkout URL
 *
 * Metadata stored on Checkout Session (used by webhook to credit wallet):
 *   wallet_id, pack_id, credits, pack_name
 */
router.post('/wallet/topup', async (req, res) => {
  const userId = req.user.id;
  const { pack_id } = req.body;

  if (!pack_id) {
    return res.status(400).json({
      error: 'pack_id is required',
      code: 'MISSING_PACK_ID',
    });
  }

  try {
    // ─── 1. Load the credit pack ─────────────────────────────────────────────
    const pack = await getCreditPackById(pack_id);
    if (!pack) {
      return res.status(404).json({
        error: 'Credit pack not found or inactive',
        code: 'PACK_NOT_FOUND',
      });
    }

    if (!pack.stripe_price_id) {
      return res.status(503).json({
        error: 'Credit pack is not configured for purchase yet',
        code: 'PACK_NOT_CONFIGURED',
      });
    }

    // ─── 2. Get or create wallet ─────────────────────────────────────────────
    const wallet = await getOrCreateWallet(userId);

    // ─── 3. Get or create Stripe customer ────────────────────────────────────
    let stripeCustomerId = wallet.stripe_customer_id || null;

    if (!stripeCustomerId) {
      // Check profiles table as fallback (stripe-billing.js stores it there)
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id, email, full_name')
        .eq('id', userId)
        .maybeSingle();

      const userEmail = req.user.email || profile?.email || null;
      const userName = profile?.full_name || null;

      if (profile?.stripe_customer_id) {
        // Reuse existing Stripe customer from subscription billing
        stripeCustomerId = profile.stripe_customer_id;
      } else {
        // Search Stripe by email first (avoid duplicates)
        if (userEmail) {
          const existing = await stripe.customers.list({ email: userEmail, limit: 1 });
          if (existing.data.length > 0) {
            stripeCustomerId = existing.data[0].id;
          }
        }

        // Create new customer if still not found
        if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            email: userEmail || undefined,
            name: userName || undefined,
            metadata: { supabase_user_id: userId },
          });
          stripeCustomerId = customer.id;
        }
      }

      // Cache on wallet row for future lookups
      await supabase
        .from('wallets')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', wallet.id);
    }

    // ─── 4. Create Stripe Checkout Session ───────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price: pack.stripe_price_id,
          quantity: 1,
        },
      ],
      success_url: 'https://maintmentor.ai/dashboard?payment=success',
      cancel_url:  'https://maintmentor.ai/dashboard?payment=cancelled',
      metadata: {
        wallet_id:  wallet.id,
        pack_id:    pack.id,
        credits:    String(pack.credits),
        pack_name:  pack.name,
        user_id:    userId,
      },
    });

    console.log(`[topup] Checkout session created — user: ${userId}, pack: ${pack.name} (${pack.credits} credits), session: ${session.id}`);

    return res.status(200).json({
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error('POST /dashboard/wallet/topup error:', err.message);

    // Never expose raw Stripe error objects to clients
    const message = err.type?.startsWith('Stripe')
      ? 'Payment service error. Please try again.'
      : 'Failed to create checkout session';

    return res.status(500).json({
      error: message,
      code: 'CHECKOUT_FAILED',
    });
  }
});

// ─── POST /wallet/link-solana ─────────────────────────────────────────────────
/**
 * Link a Solana wallet address to the authenticated user's account.
 * Deposits sent from this address will be automatically credited.
 *
 * Request body:
 *   { "solana_address": "<base58-encoded-solana-public-key>" }
 *
 * Response:
 *   200 { success: true, solana_address: "..." }
 *   400 if solana_address is missing or invalid format
 *   500 on DB error
 *
 * Validation:
 *   - 32–44 characters
 *   - Base58 alphabet: 1-9, A-H, J-N, P-Z, a-k, m-z (no 0, O, I, l)
 */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

router.post('/wallet/link-solana', async (req, res) => {
  const userId = req.user.id;
  const { solana_address } = req.body || {};

  if (!solana_address) {
    return res.status(400).json({
      error: 'solana_address is required',
      code: 'MISSING_SOLANA_ADDRESS',
    });
  }

  if (typeof solana_address !== 'string' || !BASE58_RE.test(solana_address)) {
    return res.status(400).json({
      error: 'Invalid Solana address — must be 32–44 base58 characters',
      code: 'INVALID_SOLANA_ADDRESS',
    });
  }

  try {
    // Ensure wallet exists first
    const wallet = await getOrCreateWallet(userId);

    const { error: updateError } = await supabase
      .from('wallets')
      .update({ solana_address: solana_address })
      .eq('id', wallet.id);

    if (updateError) {
      // UNIQUE constraint violation means another account already linked this address
      if (updateError.code === '23505') {
        return res.status(409).json({
          error: 'This Solana address is already linked to another account',
          code: 'SOLANA_ADDRESS_TAKEN',
        });
      }
      console.error('Failed to link Solana address:', updateError.message);
      return res.status(500).json({
        error: 'Failed to link Solana address',
        code: 'LINK_FAILED',
      });
    }

    console.log(`[dashboard] User ${userId} linked Solana address: ${solana_address}`);
    return res.status(200).json({ success: true, solana_address });
  } catch (err) {
    console.error('POST /dashboard/wallet/link-solana error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /wallet/solana-address ────────────────────────────────────────────────
/**
 * Get the Solana wallet address linked to the authenticated user's account.
 *
 * Response:
 *   200 { solana_address: "<address>" | null }
 *   404 if no wallet exists yet
 */
router.get('/wallet/solana-address', async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('solana_address')
      .eq('user_id', userId)
      .maybeSingle();

    if (walletError) {
      console.error('Failed to fetch wallet for solana-address:', walletError.message);
      return res.status(500).json({
        error: 'Failed to retrieve wallet',
        code: 'WALLET_FETCH_FAILED',
      });
    }

    if (!wallet) {
      return res.status(404).json({
        error: 'Wallet not found',
        code: 'WALLET_NOT_FOUND',
      });
    }

    return res.status(200).json({ solana_address: wallet.solana_address || null });
  } catch (err) {
    console.error('GET /dashboard/wallet/solana-address error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /wallet/balance ────────────────────────────────────────────────────────
/**
 * Get full wallet summary for the authenticated user.
 *
 * Response:
 *   200 {
 *     balance_credits: N,
 *     balance_usd: N,
 *     solana_address: "..." | null,
 *     auto_recharge_enabled: false,
 *     stripe_customer_id: "..." | null
 *   }
 */
router.get('/wallet/balance', async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('id, balance_usd, solana_address, auto_recharge_enabled, stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Wallet not found',
          code: 'WALLET_NOT_FOUND',
        });
      }
      console.error('GET /wallet/balance error:', error.message);
      return res.status(500).json({
        error: 'Failed to retrieve wallet balance',
        code: 'WALLET_FETCH_FAILED',
      });
    }

    return res.status(200).json({
      balance_credits: wallet.balance_usd,          // 1 balance_usd unit = 1 credit
      balance_usd: wallet.balance_usd,
      solana_address: wallet.solana_address || null,
      auto_recharge_enabled: wallet.auto_recharge_enabled || false,
      stripe_customer_id: wallet.stripe_customer_id || null,
    });
  } catch (err) {
    console.error('GET /dashboard/wallet/balance error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /wallet/transactions ──────────────────────────────────────────────────
/**
 * Get paginated transaction history for the authenticated user's wallet.
 *
 * Query params:
 *   limit  — default 20, max 100
 *   offset — default 0
 *
 * Response:
 *   200 { transactions: [...], total: N, limit: N, offset: N }
 */
router.get('/wallet/transactions', async (req, res) => {
  const userId = req.user.id;

  // Parse + clamp pagination params
  let limit  = parseInt(req.query.limit,  10) || 20;
  let offset = parseInt(req.query.offset, 10) || 0;
  if (limit  < 1)   limit  = 1;
  if (limit  > 100) limit  = 100;
  if (offset < 0)   offset = 0;

  try {
    // Look up wallet_id for this user
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      if (walletError.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Wallet not found',
          code: 'WALLET_NOT_FOUND',
        });
      }
      console.error('GET /wallet/transactions wallet lookup error:', walletError.message);
      return res.status(500).json({
        error: 'Failed to retrieve wallet',
        code: 'WALLET_FETCH_FAILED',
      });
    }

    // Fetch transactions with count
    const { data: transactions, error: txError, count } = await supabase
      .from('wallet_transactions')
      .select(
        'id, amount_usd, type, description, created_at, token_mint, stripe_payment_intent_id',
        { count: 'exact' }
      )
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (txError) {
      console.error('GET /wallet/transactions fetch error:', txError.message);
      return res.status(500).json({
        error: 'Failed to retrieve transactions',
        code: 'TX_FETCH_FAILED',
      });
    }

    return res.status(200).json({
      transactions: transactions || [],
      total:  count  || 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('GET /dashboard/wallet/transactions error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /usage/summary ──────────────────────────────────────────────────────
/**
 * Get usage summary (today / this month / lifetime) for the authenticated user.
 *
 * Response:
 *   200 {
 *     today:      { queries: N, photos: N, credits_used: N },
 *     this_month: { queries: N, photos: N, credits_used: N },
 *     lifetime:   { queries: N, photos: N, credits_used: N },
 *     top_categories: [{ category: "electrical", count: N }]
 *   }
 */
router.get('/usage/summary', async (req, res) => {
  const userId = req.user.id;

  try {
    // Look up wallet_id
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      if (walletError.code === 'PGRST116') {
        // No wallet yet — return zeroed stats
        return res.status(200).json({
          today:      { queries: 0, photos: 0, credits_used: 0 },
          this_month: { queries: 0, photos: 0, credits_used: 0 },
          lifetime:   { queries: 0, photos: 0, credits_used: 0 },
          top_categories: [],
        });
      }
      console.error('GET /usage/summary wallet lookup error:', walletError.message);
      return res.status(500).json({
        error: 'Failed to retrieve wallet',
        code: 'WALLET_FETCH_FAILED',
      });
    }

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const monthStart = new Date(now);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const walletId = wallet.id;

    // Fetch all usage logs for this wallet (lifetime)
    const { data: logs, error: logsError } = await supabase
      .from('api_usage_logs')
      .select('endpoint, credits_charged, created_at')
      .eq('wallet_id', walletId)
      .order('created_at', { ascending: false });

    if (logsError) {
      console.error('GET /usage/summary logs fetch error:', logsError.message);
      return res.status(500).json({
        error: 'Failed to retrieve usage logs',
        code: 'USAGE_FETCH_FAILED',
      });
    }

    const allLogs = logs || [];

    // Helper: classify endpoint as query or photo
    function isPhoto(endpoint) {
      return endpoint && endpoint.includes('/photo');
    }
    function isQuery(endpoint) {
      return endpoint && endpoint.includes('/query');
    }

    // Aggregate helper
    function aggregate(items) {
      return items.reduce(
        (acc, log) => {
          acc.credits_used += (log.credits_charged || 0);
          if (isQuery(log.endpoint)) acc.queries++;
          else if (isPhoto(log.endpoint)) acc.photos++;
          return acc;
        },
        { queries: 0, photos: 0, credits_used: 0 }
      );
    }

    const todayLogs    = allLogs.filter(l => new Date(l.created_at) >= todayStart);
    const monthLogs    = allLogs.filter(l => new Date(l.created_at) >= monthStart);

    // Top categories — extracted from endpoint or metadata if available
    // Bucket by endpoint path segment (last path component)
    const categoryCounts = {};
    for (const log of allLogs) {
      const ep = log.endpoint || 'unknown';
      // e.g. "/api/agent/query" → "query", "/api/agent/photo" → "photo"
      const parts = ep.split('/');
      const cat = parts[parts.length - 1] || 'other';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
    const topCategories = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => ({ category, count }));

    return res.status(200).json({
      today:      aggregate(todayLogs),
      this_month: aggregate(monthLogs),
      lifetime:   aggregate(allLogs),
      top_categories: topCategories,
    });
  } catch (err) {
    console.error('GET /dashboard/usage/summary error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── GET /usage/chart ─────────────────────────────────────────────────────────
/**
 * Get daily usage data for charting.
 *
 * Query params:
 *   days — number of days to include (default 30, max 90)
 *
 * Response:
 *   200 {
 *     labels:  ["2026-06-01", ...],
 *     queries: [N, N, ...],
 *     credits: [N, N, ...]
 *   }
 */
router.get('/usage/chart', async (req, res) => {
  const userId = req.user.id;

  let days = parseInt(req.query.days, 10) || 30;
  if (days < 1)  days = 1;
  if (days > 90) days = 90;

  try {
    // Look up wallet_id
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      if (walletError.code === 'PGRST116') {
        // No wallet — return empty chart with correct number of data points
        const labels   = [];
        const queries  = [];
        const credits  = [];
        const now = new Date();
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(now);
          d.setUTCDate(d.getUTCDate() - i);
          d.setUTCHours(0, 0, 0, 0);
          labels.push(d.toISOString().slice(0, 10));
          queries.push(0);
          credits.push(0);
        }
        return res.status(200).json({ labels, queries, credits });
      }
      console.error('GET /usage/chart wallet lookup error:', walletError.message);
      return res.status(500).json({
        error: 'Failed to retrieve wallet',
        code: 'WALLET_FETCH_FAILED',
      });
    }

    const now = new Date();
    const rangeStart = new Date(now);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - (days - 1));
    rangeStart.setUTCHours(0, 0, 0, 0);

    // Fetch usage logs in range
    const { data: logs, error: logsError } = await supabase
      .from('api_usage_logs')
      .select('endpoint, credits_charged, created_at')
      .eq('wallet_id', wallet.id)
      .gte('created_at', rangeStart.toISOString())
      .order('created_at', { ascending: true });

    if (logsError) {
      console.error('GET /usage/chart logs fetch error:', logsError.message);
      return res.status(500).json({
        error: 'Failed to retrieve usage logs',
        code: 'USAGE_FETCH_FAILED',
      });
    }

    // Build a map: "YYYY-MM-DD" → { queries, credits }
    const dayMap = {};
    for (const log of (logs || [])) {
      const dateKey = new Date(log.created_at).toISOString().slice(0, 10);
      if (!dayMap[dateKey]) dayMap[dateKey] = { queries: 0, credits: 0 };
      dayMap[dateKey].credits += (log.credits_charged || 0);
      if (log.endpoint && log.endpoint.includes('/query')) dayMap[dateKey].queries++;
      else if (log.endpoint && log.endpoint.includes('/photo')) dayMap[dateKey].queries++; // photos count as queries for charting
    }

    // Build ordered arrays for all `days` calendar days
    const labels  = [];
    const queries = [];
    const credits = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      d.setUTCHours(0, 0, 0, 0);
      const dateKey = d.toISOString().slice(0, 10);
      labels.push(dateKey);
      queries.push((dayMap[dateKey] || {}).queries || 0);
      credits.push((dayMap[dateKey] || {}).credits || 0);
    }

    return res.status(200).json({ labels, queries, credits });
  } catch (err) {
    console.error('GET /dashboard/usage/chart error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── POST /keys/rotate ──────────────────────────────────────────────────────
/**
 * Rotate an API key — generate a replacement, revoke the old one atomically.
 *
 * The old key is marked is_active=false with revoked_at + rotated_at timestamps.
 * The new key is returned ONCE as plaintext. Store it securely; it cannot be
 * recovered after this response.
 *
 * Request body:
 *   { "key_id": "uuid" }  — ID of the key to rotate (required)
 *
 * Response:
 *   200 {
 *     key:        "<new raw key — shown ONCE>",
 *     prefix:     "mm_pk_xxxxxxxx",
 *     label:      "...",
 *     created_at: "...",
 *     rotated_key_id: "<old key id that was revoked>"
 *   }
 *
 * Errors:
 *   400 MISSING_KEY_ID   — key_id not provided
 *   404 KEY_NOT_FOUND    — key doesn't exist or belongs to a different user
 *   409 KEY_ALREADY_REVOKED — key is already inactive (can't rotate a dead key)
 */
router.post('/keys/rotate', async (req, res) => {
  const userId = req.user.id;
  const { key_id } = req.body || {};

  if (!key_id) {
    return res.status(400).json({
      error: 'key_id is required',
      code:  'MISSING_KEY_ID',
    });
  }

  try {
    // 1. Fetch the key to rotate
    const { data: oldKey, error: fetchErr } = await supabase
      .from('api_keys')
      .select('id, user_id, wallet_id, label, is_active, revoked_at')
      .eq('id', key_id)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !oldKey) {
      return res.status(404).json({
        error: 'API key not found',
        code:  'KEY_NOT_FOUND',
      });
    }

    if (!oldKey.is_active) {
      return res.status(409).json({
        error: 'API key is already revoked — cannot rotate an inactive key',
        code:  'KEY_ALREADY_REVOKED',
      });
    }

    // 2. Generate the replacement key
    const rawKey  = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const prefix  = getKeyPrefix(rawKey);
    const now     = new Date().toISOString();

    // 3. Insert the new key
    const { data: newKey, error: insertErr } = await supabase
      .from('api_keys')
      .insert({
        user_id:    userId,
        wallet_id:  oldKey.wallet_id,
        key_hash:   keyHash,
        key_prefix: prefix,
        label:      oldKey.label ? `${oldKey.label} (rotated)` : null,
        is_active:  true,
      })
      .select('id, key_prefix, label, created_at')
      .single();

    if (insertErr) {
      console.error('POST /keys/rotate failed to insert new key:', insertErr.message);
      return res.status(500).json({
        error: 'Failed to create replacement key',
        code:  'KEY_CREATE_FAILED',
      });
    }

    // 4. Revoke the old key (mark rotated)
    // Base update — always safe (columns exist from Day 1)
    const revokeFields = {
      is_active:  false,
      revoked_at: now,
    };
    // Try to add rotated_at/rotated_to if migration has been applied
    // If columns don't exist, Supabase returns an error we can ignore safely
    let { error: revokeErr } = await supabase
      .from('api_keys')
      .update({ ...revokeFields, rotated_at: now, rotated_to: newKey.id })
      .eq('id', oldKey.id)
      .eq('user_id', userId);

    if (revokeErr) {
      // If error is about unknown column (rotated_at/rotated_to), retry without those fields
      const isColumnErr = revokeErr.message && (
        revokeErr.message.includes('rotated_at') ||
        revokeErr.message.includes('rotated_to') ||
        revokeErr.message.includes('Could not find')
      );
      if (isColumnErr) {
        // Column doesn't exist yet (migration pending) — revoke without audit fields
        const retry = await supabase
          .from('api_keys')
          .update(revokeFields)
          .eq('id', oldKey.id)
          .eq('user_id', userId);
        revokeErr = retry.error;
      }
    }

    if (revokeErr) {
      console.error('POST /keys/rotate failed to revoke old key:', revokeErr.message);
      // Attempt cleanup of the new key to avoid orphan
      await supabase.from('api_keys').delete().eq('id', newKey.id);
      return res.status(500).json({
        error: 'Failed to revoke old key — rotation aborted',
        code:  'KEY_REVOKE_FAILED',
      });
    }

    console.log(`[dashboard] Key rotated — user: ${userId}, old: ${oldKey.id}, new: ${newKey.id}`);

    // 5. Return new key ONCE
    return res.status(200).json({
      key:            rawKey,
      prefix:         newKey.key_prefix,
      label:          newKey.label,
      created_at:     newKey.created_at,
      rotated_key_id: oldKey.id,
    });
  } catch (err) {
    console.error('POST /dashboard/keys/rotate error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code:  'INTERNAL_ERROR',
    });
  }
});

// ─── POST /alerts ───────────────────────────────────────────────────────────────
/**
 * Set a low-balance usage alert threshold.
 *
 * Request body:
 *   { alert_type: 'low_balance', threshold: number, enabled?: boolean }
 *
 * Response:
 *   201 { alert_id, alert_type, threshold, enabled }
 */
router.post('/alerts', async (req, res) => {
  const userId = req.user.id;
  const { alert_type = 'low_balance', threshold, enabled = true } = req.body || {};

  if (threshold === undefined || threshold === null) {
    return res.status(400).json({ error: 'threshold is required', code: 'MISSING_THRESHOLD' });
  }

  const thresh = Number(threshold);
  if (isNaN(thresh) || thresh < 0) {
    return res.status(400).json({ error: 'threshold must be a non-negative number', code: 'INVALID_THRESHOLD' });
  }

  try {
    // Upsert alert — one alert per user per type
    const { data: existing } = await supabase
      .from('user_alerts')
      .select('id')
      .eq('user_id', userId)
      .eq('alert_type', alert_type)
      .maybeSingle();

    let alert;
    if (existing) {
      const { data: updated, error } = await supabase
        .from('user_alerts')
        .update({ threshold: thresh, enabled: Boolean(enabled) })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      alert = updated;
    } else {
      const { data: inserted, error } = await supabase
        .from('user_alerts')
        .insert({ user_id: userId, alert_type, threshold: thresh, enabled: Boolean(enabled) })
        .select()
        .single();
      if (error) throw error;
      alert = inserted;
    }

    console.log(`[dashboard] Alert set — user: ${userId}, type: ${alert_type}, threshold: ${thresh}`);

    return res.status(201).json({
      success: true,
      alert: {
        id:         alert.id,
        alert_type: alert.alert_type,
        threshold:  alert.threshold,
        enabled:    alert.enabled,
        created_at: alert.created_at,
      },
    });
  } catch (err) {
    console.error('[dashboard] POST /alerts error:', err.message);
    return res.status(500).json({ error: 'Failed to save alert', code: 'INTERNAL_ERROR' });
  }
});

// ─── GET /alerts ──────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  const userId = req.user.id;
  try {
    const { data: alerts, error } = await supabase
      .from('user_alerts')
      .select('id, alert_type, threshold, enabled, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, alerts: alerts || [] });
  } catch (err) {
    console.error('[dashboard] GET /alerts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch alerts', code: 'INTERNAL_ERROR' });
  }
});

// ─── DELETE /alerts/:id ───────────────────────────────────────────────────────
router.delete('/alerts/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('user_alerts')
      .delete()
      .eq('id', id)
      .eq('user_id', userId); // ensure ownership

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[dashboard] DELETE /alerts error:', err.message);
    return res.status(500).json({ error: 'Failed to delete alert', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;



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

module.exports = router;

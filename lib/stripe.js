'use strict';

/**
 * lib/stripe.js
 *
 * Shared Stripe client for MaintMentor credit-pack billing.
 * Exposes a single Stripe instance and helper functions for
 * fetching active credit packs from Supabase.
 *
 * SECURITY: Never log STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Stripe = require('stripe');
const supabase = require('./supabase');

// ─── Validate secret key is present ───────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set in environment variables');
}

/**
 * Shared Stripe client instance.
 * Use this everywhere — do NOT create multiple Stripe instances.
 * @type {import('stripe').Stripe}
 */
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  // Retry transient errors automatically (network issues, 500s from Stripe)
  maxNetworkRetries: 2,
});

/**
 * Fetch all active credit packs from the Supabase `credit_packs` table.
 * Returns packs sorted by price ascending (cheapest first).
 *
 * Each pack has:
 *   - id (uuid)
 *   - name (text)           e.g. "Starter"
 *   - credits (integer)     e.g. 250
 *   - price_usd (numeric)   e.g. 25.00
 *   - stripe_price_id (text) e.g. "price_abc123"
 *   - is_active (boolean)
 *   - description (text, nullable)
 *
 * @returns {Promise<Array>} Array of active credit pack rows.
 * @throws {Error} If the Supabase query fails.
 */
async function getActiveCreditPacks() {
  const { data, error } = await supabase
    .from('credit_packs')
    .select('id, name, credits, price_cents, stripe_price_id, is_active')
    .eq('is_active', true)
    .order('price_cents', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch credit packs: ${error.message}`);
  }

  return data || [];
}

/**
 * Fetch a single credit pack by ID.
 * Returns null if not found or not active.
 *
 * @param {string} packId - The UUID of the credit pack.
 * @returns {Promise<Object|null>} The credit pack row, or null.
 */
async function getCreditPackById(packId) {
  if (!packId) return null;

  const { data, error } = await supabase
    .from('credit_packs')
    .select('id, name, credits, price_cents, stripe_price_id, is_active')
    .eq('id', packId)
    .eq('is_active', true)
    .single();

  if (error) {
    // PGRST116 = row not found — not an application error
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to fetch credit pack ${packId}: ${error.message}`);
  }

  return data;
}

module.exports = {
  stripe,
  getActiveCreditPacks,
  getCreditPackById,
};

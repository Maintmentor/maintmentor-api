'use strict';

/**
 * lib/wallet.js
 *
 * Wallet management utilities for MaintMentor billing.
 * Each user has exactly one wallet. Wallets track credit balance
 * and lifetime usage statistics.
 *
 * Database table: wallets
 *   - id (uuid)
 *   - user_id (uuid, unique)
 *   - balance_usd (numeric, default 0)
 *   - lifetime_queries (integer, default 0)
 *   - lifetime_spend_usd (numeric, default 0)
 *   - created_at (timestamptz)
 *   - updated_at (timestamptz)
 */

const supabase = require('./supabase');

/**
 * Creates a new wallet for a user.
 * Will fail if a wallet already exists (user_id has a UNIQUE constraint).
 * Use getOrCreateWallet() for idempotent behavior.
 *
 * @param {string} userId - The Supabase user UUID.
 * @returns {Promise<Object>} The newly created wallet record.
 * @throws {Error} If the insert fails (e.g. duplicate user_id).
 */
async function createWallet(userId) {
  if (!userId) throw new Error('userId is required to create a wallet');

  const { data, error } = await supabase
    .from('wallets')
    .insert({ user_id: userId })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create wallet for user ${userId}: ${error.message}`);
  }

  return data;
}

/**
 * Fetches the wallet for a given user.
 *
 * @param {string} userId - The Supabase user UUID.
 * @returns {Promise<Object|null>} The wallet record, or null if not found.
 * @throws {Error} If the query fails for reasons other than not-found.
 */
async function getWallet(userId) {
  if (!userId) throw new Error('userId is required to fetch a wallet');

  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    // PGRST116 = no rows found — not an error, just means no wallet yet
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to fetch wallet for user ${userId}: ${error.message}`);
  }

  return data;
}

/**
 * Idempotently fetches or creates a wallet for a user.
 * If the wallet already exists, returns it. Otherwise creates one.
 * Safe to call multiple times — will not create duplicate wallets.
 *
 * @param {string} userId - The Supabase user UUID.
 * @returns {Promise<Object>} The existing or newly created wallet record.
 * @throws {Error} If both fetch and create fail.
 */
async function getOrCreateWallet(userId) {
  if (!userId) throw new Error('userId is required');

  // Try to fetch existing wallet first
  const existing = await getWallet(userId);
  if (existing) return existing;

  // No wallet found — create one
  // Use upsert to handle race conditions gracefully
  const { data, error } = await supabase
    .from('wallets')
    .upsert(
      { user_id: userId },
      { onConflict: 'user_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to get or create wallet for user ${userId}: ${error.message}`);
  }

  return data;
}

module.exports = {
  createWallet,
  getWallet,
  getOrCreateWallet,
};

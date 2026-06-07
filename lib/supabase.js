'use strict';

/**
 * lib/supabase.js
 *
 * Shared Supabase service-role client for server-side use.
 * Uses the service key to bypass RLS — NEVER expose this client
 * or its key to end users / browser code.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL is not set in environment variables');
}
if (!SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_SERVICE_KEY is not set in environment variables');
}

/**
 * Service-role Supabase client.
 * Bypasses Row Level Security — server-side use only.
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    // Disable auto-refresh and persistent sessions for server-side service client
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

module.exports = supabase;

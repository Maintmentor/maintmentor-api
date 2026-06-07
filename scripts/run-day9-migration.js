'use strict';

/**
 * scripts/run-day9-migration.js
 *
 * Applies the Day 9 RLS + anomaly_events migration to Supabase.
 *
 * Usage:
 *   node scripts/run-day9-migration.js
 *
 * Requirements:
 *   - SUPABASE_DB_URL or direct pg env vars in .env
 *   - pg package installed (already in node_modules)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path  = require('path');
const fs    = require('fs');
const { Client } = require('pg');

const MIGRATION_FILE = path.join(__dirname, '../supabase/migrations/20260607_day9_rls.sql');

async function run() {
  const client = new Client({
    host:     process.env.SUPABASE_DB_HOST || 'db.rxzbnvvtzhgogeuhajvp.supabase.co',
    port:     parseInt(process.env.SUPABASE_DB_PORT || '5432'),
    user:     process.env.SUPABASE_DB_USER || 'postgres',
    password: process.env.SUPABASE_DB_PASS || process.env.SUPABASE_DB_URL?.match(/:([^@]+)@/)?.[1],
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    ssl:      { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  if (!client.password) {
    // Try extracting password from SUPABASE_DB_URL
    const url = process.env.SUPABASE_DB_URL;
    if (url) {
      // URL format: postgresql://user:pass@host:port/db
      const match = url.match(/postgres(?:ql)?:\/\/[^:]+:([^@]+)@/);
      if (match) client.password = decodeURIComponent(match[1]);
    }
  }

  console.log('Connecting to Supabase PostgreSQL...');
  console.log('Host:', client.host + ':' + client.port);

  try {
    await client.connect();
    console.log('✅ Connected\n');

    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    console.log('Applying migration:', MIGRATION_FILE);

    // Execute as a single transaction
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('\n✅ Migration applied successfully!');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('\n❌ Migration failed, rolled back:', err.message);
      process.exit(1);
    }

    // Verify
    const res = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'anomaly_events'
    `);
    if (res.rows.length > 0) {
      console.log('✅ anomaly_events table exists');
    }

    const rls = await client.query(`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public'
      AND tablename IN ('wallets','api_keys','wallet_transactions','api_usage_logs')
      ORDER BY tablename, policyname
    `);
    console.log(`\n✅ ${rls.rows.length} RLS policies applied:`);
    rls.rows.forEach(r => console.log(`   ${r.tablename}: ${r.policyname}`));

  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    console.error('\nPlease run this SQL manually in Supabase SQL Editor:');
    console.error('   Dashboard → SQL Editor → paste contents of:');
    console.error('   ' + MIGRATION_FILE);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

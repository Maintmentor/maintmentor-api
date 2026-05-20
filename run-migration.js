/**
 * Run database migration for security tables
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Fab9B0RpjnfuisyYXOv9_A_rj8Zshud';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runMigration() {
  console.log('Running security tables migration...\n');

  // Test each table by trying to select from it, then create if needed
  const tables = [
    {
      name: 'daily_usage',
      test: () => supabase.from('daily_usage').select('user_id').limit(1),
      create: async () => {
        // Try inserting a test row
        const { error } = await supabase.from('daily_usage').insert({
          user_id: '__migration_test__',
          day: '2000-01-01',
          query_count: 0,
          photo_count: 0,
        });
        if (!error || error.code === '23505') {
          // Table exists, clean up
          await supabase.from('daily_usage').delete().eq('user_id', '__migration_test__');
          return true;
        }
        return false;
      }
    },
    {
      name: 'active_sessions',
      test: () => supabase.from('active_sessions').select('user_id').limit(1),
    },
    {
      name: 'device_fingerprints',
      test: () => supabase.from('device_fingerprints').select('user_id').limit(1),
    },
    {
      name: 'session_geolocations',
      test: () => supabase.from('session_geolocations').select('user_id').limit(1),
    },
    {
      name: 'anomaly_flags',
      test: () => supabase.from('anomaly_flags').select('user_id').limit(1),
    },
    {
      name: 'payment_methods',
      test: () => supabase.from('payment_methods').select('user_id').limit(1),
    },
  ];

  for (const table of tables) {
    const { error } = await table.test();
    if (error && error.code === '42P01') {
      console.log(`❌ Table "${table.name}" does not exist — needs to be created via SQL`);
    } else if (error) {
      console.log(`⚠️  Table "${table.name}": ${error.message}`);
    } else {
      console.log(`✅ Table "${table.name}" exists and accessible`);
    }
  }

  // Check profiles columns
  console.log('\nChecking profiles table columns...');
  const { data: profileSample, error: profileErr } = await supabase
    .from('profiles')
    .select('phone_number, phone_verified, cancelled_at')
    .limit(1);

  if (profileErr) {
    console.log(`⚠️  Profiles column check: ${profileErr.message}`);
    console.log('   Some columns may need to be added via SQL');
  } else {
    console.log('✅ Profiles columns (phone_number, phone_verified, cancelled_at) accessible');
  }

  // Try using RPC functions
  console.log('\nChecking RPC functions...');
  try {
    const { error: rpcErr } = await supabase.rpc('increment_daily_query', {
      p_user_id: '__test__',
      p_day: '2000-01-01'
    });
    if (rpcErr) {
      console.log(`⚠️  RPC increment_daily_query: ${rpcErr.message}`);
    } else {
      console.log('✅ RPC increment_daily_query works');
      await supabase.from('daily_usage').delete().eq('user_id', '__test__');
    }
  } catch (e) {
    console.log(`⚠️  RPC test failed: ${e.message}`);
  }

  console.log('\n=== Migration check complete ===');
  console.log('\nIf tables are missing, run the SQL in migrations/001-security-tables.sql');
  console.log('against your Supabase database using the SQL Editor.');
}

runMigration().catch(console.error);

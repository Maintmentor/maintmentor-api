const { Pool } = require('pg');
require('dotenv').config();

// Parse DB URL: postgresql://postgres:Ceceali01@@db.rxzbnvvtzhgogeuhajvp.supabase.co:5432/postgres
// Password has @ in it, so split manually
const rawUrl = process.env.SUPABASE_DB_URL || '';
console.log('DB URL (redacted):', rawUrl.replace(/:[^@]+@/, ':***@'));

// Manual parse for passwords with @ sign
// Format: postgresql://user:pass@@host:port/db  -> pass = "Ceceali01@", host after last @
const match = rawUrl.match(/^postgresql:\/\/([^:]+):(.+)@([^@\/]+):(\d+)\/(.+)$/);
let pool;

if (match) {
  // This only works if there's one @ in password region
  // Try splitting from the right: find host:port/db at the end
  const [_, user, , , port, db] = match;
  // Re-parse: everything between first : and last @ before host is password
  const withoutScheme = rawUrl.replace('postgresql://', '');
  const lastAtIdx = withoutScheme.lastIndexOf('@');
  const userPassPart = withoutScheme.substring(0, lastAtIdx);
  const hostPart = withoutScheme.substring(lastAtIdx + 1);
  const colonIdx = userPassPart.indexOf(':');
  const pgUser = userPassPart.substring(0, colonIdx);
  const pgPass = userPassPart.substring(colonIdx + 1);
  const [host, portDb] = hostPart.split(':');
  const [pgPort, pgDb] = portDb.split('/');
  
  console.log('Parsed - user:', pgUser, 'host:', host, 'port:', pgPort, 'db:', pgDb, 'pass length:', pgPass.length);
  
  pool = new Pool({
    host,
    port: parseInt(pgPort),
    database: pgDb,
    user: pgUser,
    password: pgPass,
    ssl: { rejectUnauthorized: false },
  });
} else {
  console.error('Could not parse DB URL');
  process.exit(1);
}

const migrations = [
  {
    label: 'Add columns to inspect_inspection_items',
    sql: `ALTER TABLE inspect_inspection_items 
      ADD COLUMN IF NOT EXISTS trade_category TEXT,
      ADD COLUMN IF NOT EXISTS equipment_age_years INTEGER,
      ADD COLUMN IF NOT EXISTS make_model TEXT,
      ADD COLUMN IF NOT EXISTS estimated_repair_cost NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS actual_repair_cost NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
      ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS urgency TEXT DEFAULT 'routine';`
  },
  {
    label: 'Add columns to query_history',
    sql: `ALTER TABLE query_history 
      ADD COLUMN IF NOT EXISTS trade_category TEXT,
      ADD COLUMN IF NOT EXISTS resolution_confirmed BOOLEAN,
      ADD COLUMN IF NOT EXISTS climate_region TEXT;`
  },
  {
    label: 'Drop and recreate inspect_assets table',
    sql: `
      DROP TABLE IF EXISTS inspect_assets CASCADE;
      CREATE TABLE inspect_assets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id UUID REFERENCES inspect_properties(id) ON DELETE CASCADE,
        unit_id UUID REFERENCES inspect_units(id) ON DELETE SET NULL,
        asset_type TEXT NOT NULL,
        trade_category TEXT NOT NULL,
        make TEXT,
        model TEXT,
        serial_number TEXT,
        install_date DATE,
        age_years INTEGER GENERATED ALWAYS AS (EXTRACT(YEAR FROM AGE(NOW(), install_date))::INTEGER) STORED,
        expected_lifespan_years INTEGER,
        last_service_date DATE,
        condition TEXT DEFAULT 'unknown',
        notes TEXT,
        created_by UUID REFERENCES auth.users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`
  },
  {
    label: 'Create repair_outcomes table',
    sql: `
      CREATE TABLE IF NOT EXISTS repair_outcomes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inspection_item_id UUID REFERENCES inspect_inspection_items(id) ON DELETE CASCADE,
        asset_id UUID REFERENCES inspect_assets(id) ON DELETE SET NULL,
        trade_category TEXT,
        repair_type TEXT,
        contractor_type TEXT,
        labor_hours NUMERIC(5,2),
        parts_cost NUMERIC(10,2),
        labor_cost NUMERIC(10,2),
        total_cost NUMERIC(10,2) GENERATED ALWAYS AS (COALESCE(parts_cost,0) + COALESCE(labor_cost,0)) STORED,
        completed_at TIMESTAMPTZ,
        completed_by UUID REFERENCES auth.users(id),
        root_cause TEXT,
        prevention_notes TEXT,
        warranty_expiry DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`
  },
];

async function main() {
  const client = await pool.connect();
  console.log('✅ Connected to database\n');
  
  for (const m of migrations) {
    try {
      await client.query(m.sql);
      console.log(`✅ ${m.label}`);
    } catch (err) {
      console.error(`❌ ${m.label}: ${err.message}`);
      // Continue with next migration
    }
  }
  
  // Verify
  console.log('\n── Verification ──');
  const { rows: cols } = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'inspect_inspection_items' 
    AND column_name IN ('trade_category','equipment_age_years','make_model','estimated_repair_cost','urgency')
    ORDER BY column_name;
  `);
  console.log('inspect_inspection_items new cols:', cols.map(r => r.column_name));
  
  const { rows: qhCols } = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'query_history' 
    AND column_name IN ('trade_category','resolution_confirmed','climate_region')
    ORDER BY column_name;
  `);
  console.log('query_history new cols:', qhCols.map(r => r.column_name));
  
  const { rows: tables } = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name IN ('inspect_assets','repair_outcomes')
    ORDER BY table_name;
  `);
  console.log('New tables:', tables.map(r => r.table_name));
  
  client.release();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

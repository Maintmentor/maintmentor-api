'use strict';

/**
 * scripts/setup-stripe-products.js
 *
 * One-time (idempotent) setup script for MaintMentor credit pack
 * Stripe Products and Prices.
 *
 * What it does:
 *   1. Creates 3 Stripe Products (Starter, Pro, Scale) if they don't exist
 *   2. Creates one-time Prices for each pack if they don't exist
 *   3. Updates the `credit_packs` Supabase table with real Stripe Price IDs
 *   4. Adds stripe_customer_id column to wallets table (if not present)
 *
 * Idempotency: Products are identified by metadata.maintmentor_pack = "true"
 *              and metadata.pack_slug = "<slug>". Safe to run multiple times.
 *
 * Run with: node scripts/setup-stripe-products.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ────────────────────────────────────────────────────────────────────

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY not set');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  maxNetworkRetries: 2,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Credit Pack Definitions ───────────────────────────────────────────────────

const CREDIT_PACKS = [
  {
    slug: 'starter',
    name: 'Starter Pack',
    nameMatch: 'Starter',        // matches existing DB row
    description: '250 AI query credits — great for light use. Credits never expire.',
    credits: 250,
    price_usd: 25.00,
    price_cents: 2500,
    sort_order: 1,
  },
  {
    slug: 'pro',
    name: 'Pro Pack',
    nameMatch: 'Pro',
    description: '1,100 AI query credits — best value for regular users. Credits never expire.',
    credits: 1100,
    price_usd: 99.00,
    price_cents: 9900,
    sort_order: 2,
  },
  {
    slug: 'scale',
    name: 'Scale Pack',
    nameMatch: 'Scale',
    description: '6,000 AI query credits — for power users and teams. Credits never expire.',
    credits: 6000,
    price_usd: 499.00,
    price_cents: 49900,
    sort_order: 3,
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 MaintMentor Stripe Credit Pack Setup\n');

  const results = [];

  for (const pack of CREDIT_PACKS) {
    console.log(`─── Processing: ${pack.name} ($${pack.price_usd} / ${pack.price_cents}¢) ───`);

    // ─── Step 1: Find or create Stripe Product ───────────────────────────────
    let product;
    let productCreated = false;

    // Search for existing product by pack_slug metadata
    const existingProducts = await stripe.products.list({
      limit: 100,
      active: true,
    });

    product = existingProducts.data.find(
      p => p.metadata.maintmentor_pack === 'true' && p.metadata.pack_slug === pack.slug
    );

    if (product) {
      console.log(`  ✅ Product already exists: ${product.id} (${product.name})`);
    } else {
      product = await stripe.products.create({
        name: pack.name,
        description: pack.description,
        metadata: {
          maintmentor_pack: 'true',
          pack_slug: pack.slug,
          credits: String(pack.credits),
        },
      });
      productCreated = true;
      console.log(`  ✨ Created product: ${product.id} (${product.name})`);
    }

    // ─── Step 2: Find or create Stripe Price (one-time) ───────────────────────
    let price;
    let priceCreated = false;

    const existingPrices = await stripe.prices.list({
      product: product.id,
      active: true,
      limit: 100,
    });

    price = existingPrices.data.find(
      p =>
        p.unit_amount === pack.price_cents &&
        p.currency === 'usd' &&
        p.type === 'one_time'
    );

    if (price) {
      console.log(`  ✅ Price already exists: ${price.id} ($${pack.price_usd} one-time)`);
    } else {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: pack.price_cents,
        currency: 'usd',
        metadata: {
          maintmentor_pack: 'true',
          pack_slug: pack.slug,
          credits: String(pack.credits),
        },
      });
      priceCreated = true;
      console.log(`  ✨ Created price: ${price.id} ($${pack.price_usd} one-time)`);
    }

    results.push({
      slug: pack.slug,
      name: pack.name,
      product_id: product.id,
      price_id: price.id,
      credits: pack.credits,
      price_usd: pack.price_usd,
      productCreated,
      priceCreated,
    });

    // ─── Step 3: Update stripe_price_id on existing credit_packs row ───────────
    // The table schema: id, name, price_cents, credits, stripe_price_id, is_active, created_at
    // Rows already exist with placeholder price IDs — update them by matching name.
    const { data: existingRow, error: fetchRowError } = await supabase
      .from('credit_packs')
      .select('id, name, stripe_price_id')
      .ilike('name', pack.nameMatch)
      .single();

    if (fetchRowError || !existingRow) {
      // No existing row — insert a new one with the actual schema columns
      const { error: insertError } = await supabase
        .from('credit_packs')
        .insert({
          name: pack.name,
          price_cents: pack.price_cents,
          credits: pack.credits,
          stripe_price_id: price.id,
          is_active: true,
        });

      if (insertError) {
        console.error(`  ❌ Insert failed for ${pack.slug}:`, insertError.message);
      } else {
        console.log(`  ✅ credit_packs row inserted`);
      }
    } else {
      // Existing row — update the stripe_price_id
      const { error: updateError } = await supabase
        .from('credit_packs')
        .update({
          stripe_price_id: price.id,
          price_cents: pack.price_cents,
        })
        .eq('id', existingRow.id);

      if (updateError) {
        console.error(`  ❌ Update failed for ${pack.slug}:`, updateError.message);
      } else {
        const wasPlaceholder = existingRow.stripe_price_id?.includes('REPLACE');
        console.log(`  ✅ credit_packs row updated (${wasPlaceholder ? 'replaced placeholder' : 'refreshed'} → ${price.id})`);
      }
    }

    console.log();
  }

  // ─── Step 4: Add stripe_customer_id column to wallets (if missing) ──────────
  console.log('─── Ensuring wallets.stripe_customer_id column exists ───');
  try {
    // Try a lightweight query to check if column exists
    const { error: colCheckError } = await supabase
      .from('wallets')
      .select('stripe_customer_id')
      .limit(1);

    if (colCheckError && colCheckError.message.includes('stripe_customer_id')) {
      console.log('  ⚠️  stripe_customer_id column missing from wallets.');
      console.log('  📋 Run this SQL in your Supabase dashboard:');
      console.log('     ALTER TABLE wallets ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;');
      console.log('     CREATE INDEX IF NOT EXISTS idx_wallets_stripe_customer_id ON wallets(stripe_customer_id);');
    } else {
      console.log('  ✅ wallets.stripe_customer_id column is present');
    }
  } catch (e) {
    console.warn('  ⚠️  Could not verify wallets.stripe_customer_id column:', e.message);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log('✅ Setup complete! Stripe Credit Pack IDs:\n');
  for (const r of results) {
    const action = r.priceCreated ? '✨ NEW' : '✅ EXISTING';
    console.log(`  ${action}  ${r.name.padEnd(14)} | Product: ${r.product_id} | Price: ${r.price_id}`);
  }
  console.log('\nSave these Price IDs — you need them for testing checkout!');
  console.log('════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});

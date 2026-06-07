'use strict';

/**
 * routes/webhooks.js
 *
 * Webhook handlers for MaintMentor external payment/deposit integrations.
 *
 * Route prefix: /api/webhooks  (registered in server.js BEFORE express.json())
 *
 * Endpoints:
 *   POST /api/webhooks/stripe  — Stripe credit pack checkout events
 *   POST /api/webhooks/solana  — Helius SOL deposit notifications
 *
 * Security:
 *   Stripe:  Raw body required for signature verification (STRIPE_WEBHOOK_SECRET)
 *   Solana:  Helius Authorization header verification (HELIUS_WEBHOOK_SECRET)
 *
 * Idempotency:
 *   Stripe:  Deduplicated by stripe_payment_intent_id in wallet_transactions
 *   Solana:  Deduplicated by Solana transaction signature in wallet_transactions
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const router = express.Router();
const { stripe } = require('../lib/stripe');
const supabase = require('../lib/supabase');

// ─── POST /stripe ──────────────────────────────────────────────────────────────
/**
 * Stripe webhook endpoint.
 *
 * IMPORTANT: This route uses express.raw() — registered in server.js before
 * express.json(). The raw body is required for Stripe signature verification.
 * Do NOT add express.json() here.
 */
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  // Use STRIPE_WEBHOOK_SECRET_CREDIT_PACKS if set (separate endpoint for credit packs),
  // fall back to STRIPE_WEBHOOK_SECRET for backward compatibility.
  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET_CREDIT_PACKS ||
    process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    // Misconfigured — log loudly and refuse to process
    console.error('[webhook] ❌ Neither STRIPE_WEBHOOK_SECRET_CREDIT_PACKS nor STRIPE_WEBHOOK_SECRET is configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const secretSource = process.env.STRIPE_WEBHOOK_SECRET_CREDIT_PACKS
    ? 'STRIPE_WEBHOOK_SECRET_CREDIT_PACKS'
    : 'STRIPE_WEBHOOK_SECRET (fallback)';
  if (!process.env.STRIPE_WEBHOOK_SECRET_CREDIT_PACKS) {
    console.warn('[webhook] ⚠️  STRIPE_WEBHOOK_SECRET_CREDIT_PACKS not set — using STRIPE_WEBHOOK_SECRET fallback');
  }

  // ─── Verify Stripe signature ─────────────────────────────────────────────────
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    // Invalid signature — reject with 400 (Stripe will retry)
    console.error(`[webhook] ❌ Signature verification failed: ${err.message}`);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  console.log(`[webhook] Received event: ${event.type} (id: ${event.id})`);

  // ─── Respond 200 immediately for all non-credit-pack events ──────────────────
  // Stripe expects 200 even for events we don't handle.
  // We process event handlers asynchronously after sending the response.
  res.status(200).json({ received: true });

  // ─── Handle events asynchronously (after 200 is sent) ─────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object);
        break;

      default:
        // Unhandled event — already responded 200 above, nothing to do
        console.log(`[webhook] Unhandled event type: ${event.type} — skipped`);
    }
  } catch (err) {
    // Log errors but don't re-respond (already sent 200)
    console.error(`[webhook] ❌ Error handling event ${event.type}:`, err.message);
  }
});

// ─── Handler: checkout.session.completed ──────────────────────────────────────

async function handleCheckoutSessionCompleted(session) {
  const { wallet_id, pack_id, credits, pack_name, user_id } = session.metadata || {};
  const paymentIntentId = session.payment_intent;

  // Only process credit pack purchases (not subscription checkouts)
  if (!wallet_id || !credits) {
    console.log('[webhook] checkout.session.completed — not a credit pack purchase, skipping');
    return;
  }

  const creditAmount = parseInt(credits, 10);
  if (!Number.isInteger(creditAmount) || creditAmount <= 0) {
    console.error(`[webhook] Invalid credits in metadata: "${credits}" — aborting`);
    return;
  }

  console.log(`[webhook] checkout.session.completed — wallet: ${wallet_id}, pack: ${pack_name}, credits: ${creditAmount}, payment_intent: ${paymentIntentId}`);

  // ─── IDEMPOTENCY CHECK ─────────────────────────────────────────────────────
  // Check if this payment_intent has already been processed
  if (paymentIntentId) {
    const { data: existing } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle();

    if (existing) {
      console.log(`[webhook] ⚠️  Already processed payment_intent ${paymentIntentId} — skipping (idempotency)`);
      return;
    }
  }

  // ─── Credit the wallet ─────────────────────────────────────────────────────
  // Uses the credit_wallet RPC for atomic balance update + transaction log
  const description = `Purchase: ${pack_name || 'Credit Pack'}`;

  const { error: rpcError } = await supabase.rpc('credit_wallet', {
    p_wallet_id:             wallet_id,
    p_credits:               creditAmount,
    p_description:           description,
    p_stripe_payment_intent: paymentIntentId || null,
  });

  if (rpcError) {
    console.error(`[webhook] ❌ credit_wallet RPC failed: ${rpcError.message}`);
    throw new Error(`credit_wallet failed: ${rpcError.message}`);
  }

  console.log(`[webhook] ✅ Credited ${creditAmount} credits to wallet ${wallet_id}`);

  // ─── Send confirmation email ──────────────────────────────────────────────
  if (user_id) {
    try {
      await sendCreditConfirmationEmail(user_id, creditAmount, pack_name);
    } catch (emailErr) {
      // Non-fatal — credits are already applied
      console.error('[webhook] ⚠️  Confirmation email failed (non-fatal):', emailErr.message);
    }
  }
}

// ─── Handler: payment_intent.payment_failed ───────────────────────────────────

async function handlePaymentIntentFailed(paymentIntent) {
  console.log(`[webhook] payment_intent.payment_failed — id: ${paymentIntent.id}, amount: ${paymentIntent.amount}`);

  // Find user by Stripe customer ID
  const customerId = paymentIntent.customer;
  if (!customerId) {
    console.log('[webhook] No customer on failed payment_intent — nothing to notify');
    return;
  }

  try {
    // Look up user via wallets table
    const { data: wallet } = await supabase
      .from('wallets')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();

    const userId = wallet?.user_id;

    if (!userId) {
      // Fallback: try profiles table (subscription billing stores customer there)
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();

      if (profile?.id) {
        await sendPaymentFailureEmail(profile.id, paymentIntent.id);
      } else {
        console.warn(`[webhook] No user found for Stripe customer ${customerId}`);
      }
      return;
    }

    await sendPaymentFailureEmail(userId, paymentIntent.id);
  } catch (err) {
    console.error('[webhook] ❌ Error handling payment_intent.payment_failed:', err.message);
  }
}

// ─── Email Helpers ──────────────────────────────────────────────────────────────

/**
 * Send a credit purchase confirmation email via Resend.
 * @param {string} userId - Supabase user UUID
 * @param {number} credits - Number of credits added
 * @param {string} packName - Name of the credit pack purchased
 */
async function sendCreditConfirmationEmail(userId, credits, packName) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn('[webhook] RESEND_API_KEY not set — skipping confirmation email');
    return;
  }

  // Get user email from profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', userId)
    .maybeSingle();

  const userEmail = profile?.email;
  if (!userEmail) {
    console.warn(`[webhook] No email found for user ${userId} — skipping confirmation email`);
    return;
  }

  const userName = profile?.full_name || 'there';
  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY);

  await resend.emails.send({
    from: 'MaintMentor <support@maintmentor.ai>',
    to: [userEmail],
    subject: `✅ Your ${credits.toLocaleString()} credits have been added`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden">
    <div style="background:#1e293b;padding:28px 32px;text-align:center">
      <h1 style="color:#f59e0b;font-size:22px;margin:0;font-weight:700">MaintMentor</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#1e293b;font-size:20px;margin:0 0 16px">Credits added! 🎉</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 8px">Hi ${userName},</p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px">
        Your <strong>${packName}</strong> purchase was successful.
        <strong>${credits.toLocaleString()} credits</strong> have been added to your account and are ready to use.
      </p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;margin:0 0 24px">
        <div style="color:#166534;font-size:28px;font-weight:700">+${credits.toLocaleString()}</div>
        <div style="color:#166534;font-size:14px;margin-top:4px">credits added to your wallet</div>
      </div>
      <div style="text-align:center;margin:0 0 24px">
        <a href="https://maintmentor.ai/dashboard" style="display:inline-block;background:#f59e0b;color:#1e293b;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Go to Dashboard →</a>
      </div>
      <p style="color:#94a3b8;font-size:12px;margin:0">Questions? Reply to this email — we're here to help.</p>
    </div>
    <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0">
      <p style="color:#94a3b8;font-size:12px;margin:0">© 2026 MaintMentor.ai — All rights reserved</p>
    </div>
  </div>
</body>
</html>`,
  });

  console.log(`[webhook] ✉️  Confirmation email sent to ${userEmail} (${credits} credits, ${packName})`);
}

/**
 * Send a payment failure notification email via Resend.
 * @param {string} userId - Supabase user UUID
 * @param {string} paymentIntentId - Stripe PaymentIntent ID for reference
 */
async function sendPaymentFailureEmail(userId, paymentIntentId) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn('[webhook] RESEND_API_KEY not set — skipping failure email');
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', userId)
    .maybeSingle();

  const userEmail = profile?.email;
  if (!userEmail) {
    console.warn(`[webhook] No email for user ${userId} — skipping failure email`);
    return;
  }

  const userName = profile?.full_name || 'there';
  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY);

  await resend.emails.send({
    from: 'MaintMentor <support@maintmentor.ai>',
    to: [userEmail],
    subject: '⚠️ Your MaintMentor payment did not go through',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden">
    <div style="background:#1e293b;padding:28px 32px;text-align:center">
      <h1 style="color:#f59e0b;font-size:22px;margin:0;font-weight:700">MaintMentor</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#1e293b;font-size:20px;margin:0 0 16px">Payment failed ⚠️</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 8px">Hi ${userName},</p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px">
        We were unable to process your recent payment. Your account balance has not changed.
      </p>
      <p style="color:#64748b;font-size:14px;line-height:1.6;margin:0 0 24px">
        This is usually caused by an expired card, insufficient funds, or a temporary issue with your bank.
        Please check your payment details and try again.
      </p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="https://maintmentor.ai/dashboard" style="display:inline-block;background:#f59e0b;color:#1e293b;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Try Again →</a>
      </div>
      <p style="color:#94a3b8;font-size:12px;margin:0">Reference: ${paymentIntentId || 'N/A'}</p>
    </div>
    <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0">
      <p style="color:#94a3b8;font-size:12px;margin:0">© 2026 MaintMentor.ai — All rights reserved</p>
    </div>
  </div>
</body>
</html>`,
  });

  console.log(`[webhook] ✉️  Payment failure email sent to ${userEmail}`);
}

// ─── POST /solana ───────────────────────────────────────────────────────────────
/**
 * Helius SOL deposit webhook endpoint.
 *
 * Helius delivers a JSON array of enhanced transaction objects whenever
 * a configured address receives a SOL transfer.  We:
 *   1. Verify the Helius Authorization header secret
 *   2. Parse the raw body (registered before express.json() in server.js)
 *   3. For each native SOL transfer targeting the MaintMentor wallet address:
 *      a. Check idempotency (transaction signature in wallet_transactions)
 *      b. Get current SOL/USD price from CoinGecko
 *      c. Look up the depositing wallet by Solana address in our DB
 *      d. Call credit_wallet RPC with USD equivalent
 *      e. Send confirmation email
 *
 * Security:
 *   - HELIUS_WEBHOOK_SECRET env var compared against Authorization header
 *   - If not set: logs warning, accepts request (non-blocking failure mode)
 *   - Invalid secret: 401
 *
 * Idempotency:
 *   - Solana transaction signature stored as external_id in wallet_transactions
 *   - Duplicate deliveries are silently ignored
 *
 * SOL → Credits conversion:
 *   - 1 SOL = N USD (real-time CoinGecko)
 *   - 1 USD = 1 credit (matches existing balance_usd as credits convention)
 */
router.post('/solana', async (req, res) => {
  const heliusSecret = process.env.HELIUS_WEBHOOK_SECRET;

  // ─── Signature Verification ───────────────────────────────────────────────
  if (!heliusSecret) {
    // Log warning but continue — Helius secret is optional for initial setup
    console.warn('[solana-webhook] ⚠️  HELIUS_WEBHOOK_SECRET not set — skipping signature check');
  } else {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      console.warn('[solana-webhook] ❌ Missing Authorization header');
      return res.status(401).json({ error: 'Missing Authorization header', code: 'UNAUTHORIZED' });
    }
    if (authHeader !== heliusSecret) {
      console.warn('[solana-webhook] ❌ Invalid Helius webhook secret');
      return res.status(401).json({ error: 'Invalid webhook secret', code: 'UNAUTHORIZED' });
    }
  }

  // ─── Parse Body ──────────────────────────────────────────────────────────
  // Route is registered with express.raw(), so req.body is a Buffer
  let transactions;
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    transactions = JSON.parse(rawBody);
  } catch (parseErr) {
    console.error('[solana-webhook] ❌ Failed to parse body:', parseErr.message);
    return res.status(400).json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' });
  }

  if (!Array.isArray(transactions)) {
    // Helius may send a single object for some event types
    transactions = [transactions];
  }

  // Respond 200 immediately — Helius expects fast acknowledgment
  res.status(200).json({ received: true, count: transactions.length });

  // ─── Process each transaction asynchronously ──────────────────────────────
  for (const tx of transactions) {
    try {
      await processSolanaDeposit(tx);
    } catch (err) {
      console.error('[solana-webhook] ❌ Error processing tx:', tx?.signature, err.message);
    }
  }
});

// ─── CoinGecko SOL Price Fetcher ────────────────────────────────────────────────

/** Simple in-memory cache for SOL/USD price (valid for 60s) */
let _solPriceCache = null;

/**
 * Get the current SOL/USD price from CoinGecko.
 * Cached for 60s to avoid hammering the free tier.
 *
 * @returns {Promise<number>} USD price per SOL
 */
async function getSolUsdPrice() {
  const now = Date.now();
  if (_solPriceCache && (now - _solPriceCache.fetchedAt) < 60_000) {
    return _solPriceCache.price;
  }

  let fetchFn;
  try {
    fetchFn = fetch; // Node 18+ global
  } catch {
    fetchFn = require('node-fetch');
  }

  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`CoinGecko price API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const price = data?.solana?.usd;

  if (typeof price !== 'number' || price <= 0) {
    throw new Error(`Invalid CoinGecko response: ${JSON.stringify(data)}`);
  }

  _solPriceCache = { price, fetchedAt: now };
  console.log(`[solana-webhook] SOL/USD price: $${price} (CoinGecko)`);
  return price;
}

// ─── processSolanaDeposit ────────────────────────────────────────────────────────

/**
 * Process a single Helius enhanced transaction object.
 *
 * Helius nativeTransfers format:
 *   [
 *     { fromUserAccount: "...", toUserAccount: "...", amount: <lamports> },
 *     ...
 *   ]
 *
 * @param {object} tx - Helius enhanced transaction
 */
async function processSolanaDeposit(tx) {
  const txSignature = tx.signature;
  if (!txSignature) {
    console.warn('[solana-webhook] Transaction missing signature — skipping');
    return;
  }

  const maintmentorWallet = process.env.MAINTMENTOR_SOLANA_WALLET;
  const nativeTransfers = tx.nativeTransfers || [];

  // Filter transfers going TO the MaintMentor wallet
  const inbound = maintmentorWallet
    ? nativeTransfers.filter(t => t.toUserAccount === maintmentorWallet && t.amount > 0)
    : nativeTransfers.filter(t => t.amount > 0);

  if (inbound.length === 0) {
    console.log(`[solana-webhook] No inbound SOL transfers in tx ${txSignature} — skipping`);
    return;
  }

  for (const transfer of inbound) {
    const lamports = transfer.amount;
    const fromAddress = transfer.fromUserAccount;
    const solAmount = lamports / 1_000_000_000; // lamports → SOL

    console.log(`[solana-webhook] Inbound transfer: ${solAmount} SOL from ${fromAddress}, tx: ${txSignature}`);

    // ─── IDEMPOTENCY CHECK ────────────────────────────────────────────
    // Use transaction signature + from address as compound idempotency key
    const externalId = `sol:${txSignature}:${fromAddress}`;

    const { data: existing } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('external_id', externalId)
      .maybeSingle();

    if (existing) {
      console.log(`[solana-webhook] Already processed ${externalId} — skipping (idempotency)`);
      continue;
    }

    // ─── Resolve USD value ─────────────────────────────────────────────
    let solUsdPrice;
    try {
      solUsdPrice = await getSolUsdPrice();
    } catch (priceErr) {
      console.error(`[solana-webhook] ❌ Could not get SOL price: ${priceErr.message}`);
      // Don’t credit if we can’t determine USD value — log for manual review
      continue;
    }

    const usdValue = parseFloat((solAmount * solUsdPrice).toFixed(2));
    if (usdValue <= 0) {
      console.warn(`[solana-webhook] Computed USD value is ${usdValue} — skipping`);
      continue;
    }

    // ─── Find user wallet by Solana address ──────────────────────────────
    // Look up wallet by the fromAddress (depositor’s Solana public key)
    const { data: userWallet, error: walletLookupError } = await supabase
      .from('wallets')
      .select('id, user_id')
      .eq('solana_address', fromAddress)
      .maybeSingle();

    if (walletLookupError) {
      console.error(`[solana-webhook] Wallet lookup error: ${walletLookupError.message}`);
    }

    if (!userWallet) {
      // Unknown sender — record in a holding table or log for manual review
      console.warn(`[solana-webhook] No wallet found for Solana address ${fromAddress} — deposit of ${solAmount} SOL ($${usdValue}) not credited. Manual review required.`);
      // Still record for audit trail
      await supabase.from('wallet_transactions').insert({
        wallet_id:   null,
        amount_usd:  usdValue,
        type:        'credit_pending',
        description: `SOL deposit from unknown address ${fromAddress}: ${solAmount} SOL ($${usdValue} @ $${solUsdPrice}/SOL)`,
        external_id: externalId,
      }).then(({ error }) => {
        if (error && !error.message?.includes('null value')) {
          console.error('[solana-webhook] Failed to record unknown deposit:', error.message);
        }
      });
      continue;
    }

    // ─── Credit the wallet ─────────────────────────────────────────────
    const description = `SOL deposit: ${solAmount} SOL @ $${solUsdPrice}/SOL = $${usdValue} USD`;

    const { error: rpcError } = await supabase.rpc('credit_wallet', {
      p_wallet_id:             userWallet.id,
      p_credits:               usdValue,
      p_description:           description,
      p_stripe_payment_intent: externalId, // repurposed as generic external_id
    });

    if (rpcError) {
      console.error(`[solana-webhook] ❌ credit_wallet RPC failed: ${rpcError.message}`);
      throw new Error(`credit_wallet failed: ${rpcError.message}`);
    }

    console.log(`[solana-webhook] ✅ Credited $${usdValue} (${solAmount} SOL) to wallet ${userWallet.id}`);

    // ─── Send confirmation email ─────────────────────────────────────────
    if (userWallet.user_id) {
      try {
        await sendSolanaDepositEmail(userWallet.user_id, solAmount, usdValue, solUsdPrice, txSignature);
      } catch (emailErr) {
        // Non-fatal — credits already applied
        console.error('[solana-webhook] ⚠️  Deposit email failed (non-fatal):', emailErr.message);
      }
    }
  }
}

// ─── Email: Solana Deposit Confirmation ─────────────────────────────────────────

/**
 * Send a SOL deposit confirmation email via Resend.
 *
 * @param {string} userId         - Supabase user UUID
 * @param {number} solAmount      - Amount of SOL deposited
 * @param {number} usdValue       - USD value at time of deposit
 * @param {number} solUsdPrice    - SOL/USD exchange rate used
 * @param {string} txSignature    - Solana transaction signature
 */
async function sendSolanaDepositEmail(userId, solAmount, usdValue, solUsdPrice, txSignature) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn('[solana-webhook] RESEND_API_KEY not set — skipping deposit email');
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', userId)
    .maybeSingle();

  const userEmail = profile?.email;
  if (!userEmail) {
    console.warn(`[solana-webhook] No email for user ${userId} — skipping deposit email`);
    return;
  }

  const userName = profile?.full_name || 'there';
  const solanaExplorerUrl = `https://solscan.io/tx/${txSignature}`;

  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY);

  await resend.emails.send({
    from: 'MaintMentor <support@maintmentor.ai>',
    to: [userEmail],
    subject: `✅ SOL deposit received — $${usdValue.toFixed(2)} added to your wallet`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden">
    <div style="background:#1e293b;padding:28px 32px;text-align:center">
      <h1 style="color:#f59e0b;font-size:22px;margin:0;font-weight:700">MaintMentor</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#1e293b;font-size:20px;margin:0 0 16px">SOL Deposit Received! ◎</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 8px">Hi ${userName},</p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px">
        Your SOL deposit has been received and converted to credits.
      </p>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:0 0 16px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="color:#475569;font-size:14px;padding:4px 0">SOL deposited</td><td style="color:#1e40af;font-size:14px;font-weight:600;text-align:right">${solAmount.toFixed(9)} SOL</td></tr>
          <tr><td style="color:#475569;font-size:14px;padding:4px 0">SOL/USD rate</td><td style="color:#475569;font-size:14px;text-align:right">$${solUsdPrice.toLocaleString()}</td></tr>
          <tr style="border-top:1px solid #bfdbfe">
            <td style="color:#1e293b;font-size:15px;font-weight:700;padding:8px 0 4px">Credits added</td>
            <td style="color:#166534;font-size:18px;font-weight:700;text-align:right">+$${usdValue.toFixed(2)}</td>
          </tr>
        </table>
      </div>
      <p style="color:#64748b;font-size:13px;margin:0 0 24px">
        Transaction: <a href="${solanaExplorerUrl}" style="color:#2563eb">${txSignature.slice(0, 20)}...</a>
      </p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="https://maintmentor.ai/dashboard" style="display:inline-block;background:#f59e0b;color:#1e293b;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Go to Dashboard →</a>
      </div>
      <p style="color:#94a3b8;font-size:12px;margin:0">Questions? Reply to this email — we're here to help.</p>
    </div>
    <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0">
      <p style="color:#94a3b8;font-size:12px;margin:0">© 2026 MaintMentor.ai — All rights reserved</p>
    </div>
  </div>
</body>
</html>`,
  });

  console.log(`[solana-webhook] ✉️  Deposit confirmation email sent to ${userEmail} (${solAmount} SOL = $${usdValue})`);
}

// ─── Export the price cache resetter (for tests) ──────────────────────────────
function _resetSolPriceCache() {
  _solPriceCache = null;
}

module.exports = router;
module.exports._resetSolPriceCache = _resetSolPriceCache;
module.exports.getSolUsdPrice = getSolUsdPrice;
module.exports.processSolanaDeposit = processSolanaDeposit;

/**
 * Stripe Billing Integration for MaintMentor.ai
 * 
 * Routes:
 *   POST /api/billing/webhook       — Stripe webhook (raw body, registered BEFORE json parser)
 *   POST /api/billing/create-checkout — Create Stripe Checkout session
 *   POST /api/billing/portal         — Create Stripe Customer Portal session
 *   GET  /api/billing/status         — Get subscription status for authenticated user
 */

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { notifyNewSubscriber, notifyPaymentFailed, notifySubscriptionCancelled } = require('./notifications');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
);

// Will be set on startup after ensuring product/price exist
let PRICE_ID = process.env.STRIPE_PRICE_ID || null;

// ─── Ensure Stripe Product & Price Exist ────────────────────────────────────────
async function ensureStripeProduct() {
  try {
    // Check for existing product by metadata
    const products = await stripe.products.list({ limit: 100, active: true });
    let product = products.data.find(p => p.metadata.app === 'maintmentor');

    if (!product) {
      product = await stripe.products.create({
        name: 'MaintMentor Pro',
        description: 'AI-powered maintenance mentor — unlimited diagnostics, photo analysis, full knowledge base.',
        metadata: { app: 'maintmentor' },
      });
      console.log(`[stripe] Created product: ${product.id}`);
    } else {
      console.log(`[stripe] Found existing product: ${product.id}`);
    }

    // Check for existing $19/mo price
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
    let price = prices.data.find(p =>
      p.unit_amount === 1900 &&
      p.currency === 'usd' &&
      p.recurring?.interval === 'month'
    );

    if (!price) {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: 1900, // $19.00
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { app: 'maintmentor' },
      });
      console.log(`[stripe] Created price: ${price.id} ($19/mo)`);
    } else {
      console.log(`[stripe] Found existing price: ${price.id}`);
    }

    PRICE_ID = price.id;
    console.log(`[stripe] ✅ Product & price ready. Price ID: ${PRICE_ID}`);
  } catch (err) {
    console.error(`[stripe] ❌ Failed to ensure product/price:`, err.message);
  }
}

// ─── Auth Helper: Extract user from Supabase JWT ───────────────────────────────
async function getUserFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ─── Get or Create Stripe Customer ──────────────────────────────────────────────
async function getOrCreateStripeCustomer(userId, email, name) {
  // Check if user already has a Stripe customer ID in profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();

  if (profile?.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(profile.stripe_customer_id);
      if (!existing.deleted) return existing.id;
    } catch (e) {
      // Customer doesn't exist in Stripe anymore, create new
    }
  }

  // Search Stripe by email
  const existingCustomers = await stripe.customers.list({ email, limit: 1 });
  if (existingCustomers.data.length > 0) {
    const customerId = existingCustomers.data[0].id;
    await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
    return customerId;
  }

  // Create new customer
  const customer = await stripe.customers.create({
    email,
    name: name || undefined,
    metadata: { supabase_user_id: userId },
  });

  await supabase.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', userId);
  return customer.id;
}

// ─── Register Webhook Route (must be called BEFORE express.json()) ──────────────
function registerWebhookRoute(app) {
  const express = require('express');

  app.post('/api/billing/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set!');
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error(`[stripe-webhook] Signature verification failed:`, err.message);
        return res.status(400).json({ error: `Webhook signature verification failed` });
      }

      console.log(`[stripe-webhook] Received event: ${event.type}`);

      try {
        switch (event.type) {
          case 'checkout.session.completed':
            await handleCheckoutCompleted(event.data.object);
            break;
          case 'invoice.paid':
            await handleInvoicePaid(event.data.object);
            break;
          case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object);
            break;
          case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object);
            break;
          case 'customer.subscription.deleted':
            await handleSubscriptionDeleted(event.data.object);
            break;
          default:
            console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
        }
      } catch (err) {
        console.error(`[stripe-webhook] Error handling ${event.type}:`, err.message);
        // Still return 200 so Stripe doesn't retry on app errors
      }

      res.json({ received: true });
    }
  );
}

// ─── Webhook Event Handlers ─────────────────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  // Find user by stripe_customer_id
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!profile) {
    // Try by client_reference_id (we set this to user ID)
    const userId = session.client_reference_id;
    if (userId) {
      await supabase.from('profiles').update({
        stripe_customer_id: customerId,
        subscription_id: subscriptionId,
        subscription_status: 'active',
        subscription_tier: 'paid',
        subscription_plan: 'pro_monthly',
      }).eq('id', userId);
      console.log(`[stripe-webhook] checkout.session.completed — updated user ${userId} via client_reference_id`);
    } else {
      console.error(`[stripe-webhook] checkout.session.completed — no profile found for customer ${customerId}`);
    }
    return;
  }

  await supabase.from('profiles').update({
    subscription_id: subscriptionId,
    subscription_status: 'active',
    subscription_tier: 'paid',
    subscription_plan: 'pro_monthly',
  }).eq('id', profile.id);

  console.log(`[stripe-webhook] checkout.session.completed — user ${profile.id} now paid`);

  // Notify Dean
  const { data: userProfile } = await supabase.from('profiles').select('email, full_name').eq('id', profile.id).maybeSingle();
  notifyNewSubscriber(profile.id, userProfile?.email || userProfile?.full_name || 'Unknown');
}

async function handleInvoicePaid(invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!profile) return;

  await supabase.from('profiles').update({
    subscription_status: 'active',
    subscription_tier: 'paid',
  }).eq('id', profile.id);

  console.log(`[stripe-webhook] invoice.paid — user ${profile.id} confirmed active`);
}

async function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!profile) return;

  await supabase.from('profiles').update({
    subscription_status: 'past_due',
  }).eq('id', profile.id);

  console.log(`[stripe-webhook] invoice.payment_failed — user ${profile.id} now past_due`);

  // Notify Dean
  const { data: failedProfile } = await supabase.from('profiles').select('email, full_name').eq('id', profile.id).maybeSingle();
  notifyPaymentFailed(profile.id, failedProfile?.email || 'Unknown');
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!profile) return;

  const updates = {
    subscription_id: subscription.id,
    subscription_status: subscription.status === 'active' ? 'active' : subscription.status,
  };

  // If cancellation is scheduled (cancel_at_period_end)
  if (subscription.cancel_at_period_end) {
    updates.subscription_status = 'cancelling';
    updates.subscription_ends_at = new Date(subscription.current_period_end * 1000).toISOString();
    console.log(`[stripe-webhook] subscription.updated — user ${profile.id} cancellation scheduled for ${updates.subscription_ends_at}`);
  } else if (subscription.status === 'active') {
    updates.subscription_tier = 'paid';
    updates.subscription_ends_at = null; // Clear any scheduled end
  }

  await supabase.from('profiles').update(updates).eq('id', profile.id);
  console.log(`[stripe-webhook] subscription.updated — user ${profile.id} status: ${updates.subscription_status}`);
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!profile) return;

  await supabase.from('profiles').update({
    subscription_status: 'cancelled',
    subscription_tier: 'free',
    subscription_ends_at: new Date().toISOString(),
  }).eq('id', profile.id);

  console.log(`[stripe-webhook] subscription.deleted — user ${profile.id} now cancelled`);

  // Notify Dean
  const { data: cancelledProfile } = await supabase.from('profiles').select('email, full_name').eq('id', profile.id).maybeSingle();
  notifySubscriptionCancelled(profile.id, cancelledProfile?.email || 'Unknown');
}

// ─── Register JSON-parsed Billing Routes ────────────────────────────────────────
function registerBillingRoutes(app) {

  // POST /api/billing/create-checkout
  app.post('/api/billing/create-checkout', async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      if (!PRICE_ID) {
        return res.status(503).json({ success: false, error: 'Billing not configured yet. Try again shortly.' });
      }

      // Get profile to check trial status
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id, full_name, subscription_status, subscription_tier, trial_ends_at, role')
        .eq('id', user.id)
        .maybeSingle();

      // Admin bypass — don't need to subscribe
      if (profile?.role === 'admin') {
        return res.json({ success: false, error: 'Admin accounts have unlimited access.' });
      }

      // Already paid
      if (profile?.subscription_tier === 'paid' && profile?.subscription_status === 'active') {
        return res.json({ success: false, error: 'You already have an active subscription.' });
      }

      const customerId = await getOrCreateStripeCustomer(user.id, user.email, profile?.full_name);

      // Check if user has already had a trial (via Stripe or our DB)
      let hasHadTrial = false;
      if (profile?.trial_ends_at) {
        hasHadTrial = true;
      }

      // Also check Stripe for prior subscriptions with trials
      const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 10, status: 'all' });
      if (subscriptions.data.some(s => s.trial_end)) {
        hasHadTrial = true;
      }

      const sessionParams = {
        customer: customerId,
        client_reference_id: user.id,
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        success_url: `https://maintmentor.ai/chat?billing=success`,
        cancel_url: `https://maintmentor.ai/pricing?billing=cancelled`,
        metadata: {
          supabase_user_id: user.id,
        },
      };

      // Only offer trial if they haven't had one before
      if (!hasHadTrial) {
        sessionParams.subscription_data = {
          trial_period_days: 7,
          metadata: { supabase_user_id: user.id },
        };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      console.log(`[stripe] Checkout session created for user ${user.id}, trial: ${!hasHadTrial}`);
      res.json({ success: true, url: session.url });
    } catch (err) {
      console.error('[stripe] create-checkout error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to create checkout session' });
    }
  });

  // POST /api/billing/portal
  app.post('/api/billing/portal', async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .maybeSingle();

      if (!profile?.stripe_customer_id) {
        return res.status(400).json({ success: false, error: 'No billing account found. Subscribe first.' });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: profile.stripe_customer_id,
        return_url: 'https://maintmentor.ai/chat',
      });

      res.json({ success: true, url: portalSession.url });
    } catch (err) {
      console.error('[stripe] portal error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to create portal session' });
    }
  });

  // GET /api/billing/status
  app.get('/api/billing/status', async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('subscription_status, subscription_tier, subscription_plan, subscription_ends_at, trial_ends_at, stripe_customer_id, role')
        .eq('id', user.id)
        .maybeSingle();

      if (!profile) {
        return res.json({
          success: true,
          status: 'none',
          tier: 'free',
          hasActiveSubscription: false,
        });
      }

      // Admin always has access
      const isAdmin = profile.role === 'admin';

      // Check trial expiry
      let effectiveStatus = profile.subscription_status;
      if (effectiveStatus === 'active' && profile.subscription_tier === 'trial' && profile.trial_ends_at) {
        if (new Date(profile.trial_ends_at) < new Date()) {
          effectiveStatus = 'expired';
          // Update in DB too
          await supabase.from('profiles').update({
            subscription_status: 'expired',
          }).eq('id', user.id);
        }
      }

      res.json({
        success: true,
        status: effectiveStatus || 'none',
        tier: profile.subscription_tier || 'free',
        plan: profile.subscription_plan || null,
        endsAt: profile.subscription_ends_at || null,
        trialEndsAt: profile.trial_ends_at || null,
        hasStripeCustomer: !!profile.stripe_customer_id,
        hasActiveSubscription: isAdmin || (effectiveStatus === 'active' && profile.subscription_tier === 'paid'),
        isAdmin,
      });
    } catch (err) {
      console.error('[stripe] status error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to get billing status' });
    }
  });
}

module.exports = { registerWebhookRoute, registerBillingRoutes, ensureStripeProduct };

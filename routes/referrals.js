'use strict';

/**
 * routes/referrals.js
 *
 * Referral system for MaintMentor.
 * Each user gets an 8-character referral code on first request.
 * When a new user signs up with ?ref=CODE, the referrer earns 50 credits.
 *
 * Routes (mounted at /api/referrals):
 *   GET  /code   — get or create my referral code
 *   GET  /stats  — how many people I've referred & credits earned
 *   POST /apply  — (internal) apply a referral code on signup
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const supabase = require('../lib/supabase');
const { requireJWT } = require('../middleware/auth');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a random 8-char uppercase alphanumeric code */
function generateCode() {
  return crypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 8);
}

/**
 * Get or create a referral code for a user.
 * Returns the code string.
 */
async function getOrCreateCode(userId) {
  // Check existing code in referral_codes table
  const { data: existing } = await supabase
    .from('referral_codes')
    .select('code')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing?.code) return existing.code;

  // Generate a unique code
  let code;
  let attempts = 0;
  while (attempts < 10) {
    code = generateCode();
    const { data: conflict } = await supabase
      .from('referral_codes')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (!conflict) break;
    attempts++;
  }

  // Insert new code
  const { data: inserted, error } = await supabase
    .from('referral_codes')
    .insert({ user_id: userId, code, credits_earned: 0, referrals_count: 0 })
    .select()
    .single();

  if (error) throw new Error(`Failed to create referral code: ${error.message}`);

  // Also store code in profiles for quick lookup
  await supabase
    .from('profiles')
    .update({ referral_code: code })
    .eq('id', userId);

  return inserted.code;
}

// ─── GET /code ────────────────────────────────────────────────────────────────

router.get('/code', requireJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const code = await getOrCreateCode(userId);
    const referralUrl = `${process.env.APP_URL || 'https://maintmentor.ai'}/join/${code}`;

    res.json({
      success: true,
      code,
      referral_url: referralUrl,
    });
  } catch (err) {
    console.error('[referrals] GET /code error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to get referral code' });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

router.get('/stats', requireJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get referral record
    const { data: refRecord } = await supabase
      .from('referral_codes')
      .select('code, credits_earned, referrals_count, created_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (!refRecord) {
      // No code yet — return zeros
      return res.json({
        success: true,
        stats: {
          code: null,
          referrals_count: 0,
          credits_earned: 0,
          referral_url: null,
        },
      });
    }

    const referralUrl = `${process.env.APP_URL || 'https://maintmentor.ai'}/join/${refRecord.code}`;

    res.json({
      success: true,
      stats: {
        code: refRecord.code,
        referrals_count: refRecord.referrals_count || 0,
        credits_earned: refRecord.credits_earned || 0,
        referral_url: referralUrl,
        created_at: refRecord.created_at,
      },
    });
  } catch (err) {
    console.error('[referrals] GET /stats error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to get referral stats' });
  }
});

// ─── POST /apply ──────────────────────────────────────────────────────────────
// Called internally on signup when a referral code is present.
// Also callable by frontend after account creation.

router.post('/apply', requireJWT, async (req, res) => {
  try {
    const newUserId = req.user.id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, error: 'code is required' });
    }

    const cleanCode = code.trim().toUpperCase();

    // Find referrer by code
    const { data: refRecord, error: refErr } = await supabase
      .from('referral_codes')
      .select('id, user_id, credits_earned, referrals_count')
      .eq('code', cleanCode)
      .maybeSingle();

    if (refErr || !refRecord) {
      return res.status(404).json({ success: false, error: 'Referral code not found' });
    }

    // Don't let users refer themselves
    if (refRecord.user_id === newUserId) {
      return res.status(400).json({ success: false, error: 'Cannot use your own referral code' });
    }

    // Check if this user was already referred by someone
    const { data: profile } = await supabase
      .from('profiles')
      .select('referred_by')
      .eq('id', newUserId)
      .maybeSingle();

    if (profile?.referred_by) {
      return res.status(409).json({ success: false, error: 'Referral code already applied to this account' });
    }

    const REFERRAL_CREDITS = 50;

    // Credit the referrer's wallet
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id, balance')
      .eq('user_id', refRecord.user_id)
      .maybeSingle();

    if (wallet) {
      await supabase
        .from('wallets')
        .update({ balance: (wallet.balance || 0) + REFERRAL_CREDITS })
        .eq('id', wallet.id);

      // Log transaction
      await supabase.from('wallet_transactions').insert({
        wallet_id: wallet.id,
        type: 'credit',
        amount: REFERRAL_CREDITS,
        description: `Referral bonus — new user joined`,
        metadata: { new_user_id: newUserId, referral_code: cleanCode },
      });
    }

    // Update referral_codes stats
    await supabase
      .from('referral_codes')
      .update({
        referrals_count: (refRecord.referrals_count || 0) + 1,
        credits_earned:  (refRecord.credits_earned  || 0) + REFERRAL_CREDITS,
      })
      .eq('id', refRecord.id);

    // Record referred_by in new user's profile
    await supabase
      .from('profiles')
      .update({ referred_by: refRecord.user_id })
      .eq('id', newUserId);

    console.log(`[referrals] Applied code ${cleanCode} — user ${refRecord.user_id} earns ${REFERRAL_CREDITS} credits`);

    res.json({
      success: true,
      credits_awarded: REFERRAL_CREDITS,
      referrer_id: refRecord.user_id,
    });
  } catch (err) {
    console.error('[referrals] POST /apply error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to apply referral code' });
  }
});

// ─── GET /lookup/:code ────────────────────────────────────────────────────────
// Public — no auth. Used by /join/:code landing page to show referrer's name.

router.get('/lookup/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const cleanCode = (code || '').trim().toUpperCase();

    const { data: refRecord } = await supabase
      .from('referral_codes')
      .select('user_id')
      .eq('code', cleanCode)
      .maybeSingle();

    if (!refRecord) {
      return res.status(404).json({ success: false, error: 'Invalid referral code' });
    }

    // Get referrer's first name (no PII leak — just first name)
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', refRecord.user_id)
      .maybeSingle();

    let firstName = 'A MaintMentor user';
    if (profile?.full_name) {
      firstName = profile.full_name.split(' ')[0];
    } else if (profile?.email) {
      firstName = profile.email.split('@')[0];
    }

    res.json({ success: true, code: cleanCode, referrer_first_name: firstName });
  } catch (err) {
    console.error('[referrals] GET /lookup error:', err.message);
    res.status(500).json({ success: false, error: 'Lookup failed' });
  }
});

module.exports = router;

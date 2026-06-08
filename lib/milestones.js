'use strict';

/**
 * lib/milestones.js
 *
 * Usage milestone email notifications for MaintMentor.
 *
 * Fires a celebratory email when a user hits key query-count milestones:
 *   - First query (1)
 *   - 10 queries
 *   - 50 queries
 *   - 100 queries
 *
 * Usage:
 *   const { checkAndFireMilestone } = require('./milestones');
 *   await checkAndFireMilestone(userId, userEmail, newTotalQueryCount);
 *
 * Deduplication: milestones are stored in the `milestone_events` table.
 * If the table doesn't exist, milestone emails still fire (fire-and-forget)
 * but won't deduplicate — run the Day 12 migration to create the table.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Resend } = require('resend');
const supabase   = require('./supabase');
const logger     = require('./logger');

const FROM_EMAIL = 'winston@maintmentor.ai';
const APP_URL    = process.env.APP_URL || 'https://maintmentor.ai';

// ─── Milestone Definitions ────────────────────────────────────────────────────

const MILESTONES = [1, 10, 50, 100];

const MILESTONE_COPY = {
  1: {
    emoji:    '🎉',
    headline: 'You just asked your first question!',
    body:     'That\'s the first step toward mastering maintenance. You\'re officially a MaintMentor user — and this is just the beginning.',
    tip:      'Try uploading a photo next time for an even faster, visual diagnosis.',
  },
  10: {
    emoji:    '🔟',
    headline: 'You\'ve hit 10 queries — nice work!',
    body:     'You\'re building real maintenance skills. Experts say it takes about 10 real-world problems to start seeing patterns. You\'re there.',
    tip:      'Browse the Knowledge Base to fill in any gaps — 1000+ articles, checklists, and guides.',
  },
  50: {
    emoji:    '🏅',
    headline: '50 queries! You\'re a power user.',
    body:     'At 50 queries, you\'ve saved yourself countless service calls and are well on your way to true maintenance mastery. We\'re impressed.',
    tip:      'Have you started any certifications yet? Your query history is proving your expertise — make it official.',
  },
  100: {
    emoji:    '🏆',
    headline: '100 queries — you\'re a MaintMentor legend!',
    body:     'Triple digits. You\'ve diagnosed problems, prevented breakdowns, and built skills that will last a lifetime. You\'re exactly the kind of user we built this for.',
    tip:      'Share MaintMentor with your team — they can access it for $12/user/mo with a team plan.',
  },
};

// ─── Email Builder ────────────────────────────────────────────────────────────

function buildMilestoneEmail(milestone, userEmail, creditBalance) {
  const copy = MILESTONE_COPY[milestone];
  if (!copy) return null;

  const balanceSection = creditBalance != null
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px 18px;margin-bottom:20px">
        <p style="color:#1d4ed8;font-size:14px;font-weight:600;margin:0 0 4px">💳 Your credit balance</p>
        <p style="color:#1e40af;font-size:22px;font-weight:800;margin:0">${creditBalance} credits</p>
        <p style="color:#3b82f6;font-size:12px;margin:4px 0 0">
          Need more? <a href="${APP_URL}/#pricing" style="color:#1d4ed8;text-decoration:underline">Upgrade or top up →</a>
        </p>
      </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${copy.emoji} ${copy.headline}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:16px 16px 0 0;padding:32px;text-align:center">
      <div style="font-size:48px;margin-bottom:8px">${copy.emoji}</div>
      <h1 style="color:#f59e0b;font-size:24px;font-weight:800;margin:0 0 6px">${copy.headline}</h1>
      <p style="color:#94a3b8;font-size:13px;margin:0">${milestone === 1 ? 'First query milestone' : `${milestone} queries milestone`} · MaintMentor</p>
    </div>

    <!-- Body -->
    <div style="background:#ffffff;padding:32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
      <p style="color:#0f172a;font-size:16px;line-height:1.6;margin:0 0 20px">${copy.body}</p>

      ${balanceSection}

      <!-- Tip -->
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:14px 18px;margin-bottom:24px">
        <p style="color:#15803d;font-size:14px;font-weight:600;margin:0 0 4px">💡 Pro tip</p>
        <p style="color:#166534;font-size:13px;line-height:1.5;margin:0">${copy.tip}</p>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:20px">
        <a href="${APP_URL}/dashboard"
           style="display:inline-block;background:#f59e0b;color:#0f172a;font-weight:800;font-size:15px;padding:13px 32px;border-radius:12px;text-decoration:none">
          Keep Going →
        </a>
      </div>

      <p style="color:#94a3b8;font-size:13px;text-align:center;margin:0">
        Thanks for being a MaintMentor. You're making it better for everyone. 🙏
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center">
      <p style="color:#94a3b8;font-size:12px;margin:0">
        MaintMentor · Powered by Google Gemini AI ·
        <a href="${APP_URL}/unsubscribe" style="color:#94a3b8">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  return {
    subject: `${copy.emoji} ${copy.headline} — MaintMentor`,
    html,
  };
}

// ─── Deduplication helpers ────────────────────────────────────────────────────

async function hasMilestoneFired(userId, milestone) {
  try {
    const { data, error } = await supabase
      .from('milestone_events')
      .select('id')
      .eq('user_id', userId)
      .eq('milestone', milestone)
      .maybeSingle();

    if (error) {
      // Table may not exist yet — don't block
      logger.warn({ userId, milestone, error: error.message }, '[milestones] hasMilestoneFired query failed');
      return false;
    }
    return !!data;
  } catch (err) {
    logger.warn({ userId, milestone, err: err.message }, '[milestones] hasMilestoneFired error (non-fatal)');
    return false;
  }
}

async function recordMilestoneFired(userId, milestone) {
  try {
    const { error } = await supabase
      .from('milestone_events')
      .insert({ user_id: userId, milestone, fired_at: new Date().toISOString() });

    if (error) {
      logger.warn({ userId, milestone, error: error.message }, '[milestones] recordMilestoneFired failed');
    }
  } catch (err) {
    logger.warn({ userId, milestone, err: err.message }, '[milestones] recordMilestoneFired error (non-fatal)');
  }
}

// ─── Credit balance lookup ────────────────────────────────────────────────────

async function getCreditBalance(userId) {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return null;
    return data.balance;
  } catch (_) {
    return null;
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Check if the user's new total query count hits a milestone.
 * If so, send the milestone email (once per milestone, deduplicated via DB).
 *
 * @param {string} userId
 * @param {string} userEmail
 * @param {number} newTotalCount - the user's new total query count after the latest query
 */
async function checkAndFireMilestone(userId, userEmail, newTotalCount) {
  // Only check if count is exactly a milestone value
  if (!MILESTONES.includes(newTotalCount)) return;

  const milestone = newTotalCount;

  // Deduplicate
  const alreadyFired = await hasMilestoneFired(userId, milestone);
  if (alreadyFired) return;

  // Build email
  const balance = await getCreditBalance(userId);
  const emailContent = buildMilestoneEmail(milestone, userEmail, balance);
  if (!emailContent) return;

  // Send
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    logger.warn({ userId, milestone }, '[milestones] RESEND_API_KEY not set — skipping milestone email');
    return;
  }

  try {
    const resend = new Resend(RESEND_API_KEY);
    const result = await resend.emails.send({
      from:    FROM_EMAIL,
      to:      userEmail,
      subject: emailContent.subject,
      html:    emailContent.html,
    });
    logger.info({ userId, milestone, emailId: result?.id }, `[milestones] Milestone ${milestone} email sent`);
    await recordMilestoneFired(userId, milestone);
  } catch (err) {
    logger.error({ userId, milestone, err: err.message }, '[milestones] Failed to send milestone email');
  }
}

/**
 * Get the list of milestone values.
 * Useful for tests.
 */
function getMilestones() {
  return [...MILESTONES];
}

module.exports = {
  checkAndFireMilestone,
  getMilestones,
  buildMilestoneEmail,
  hasMilestoneFired,
  recordMilestoneFired,
};

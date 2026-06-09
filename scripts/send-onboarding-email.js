'use strict';

/**
 * scripts/send-onboarding-email.js
 *
 * MaintMentor Onboarding Email Sequence
 *
 * Exports three functions used by the auth flow and a cron/scheduler:
 *   sendWelcomeEmail(user)      — fires immediately on signup
 *   sendDay3FollowUp(user)      — day 3: "Have you tried the AI yet?"
 *   sendDay7CheckIn(user)       — day 7: "Here's what MaintMentor can do for your team"
 *
 * Also exports: sendOnboardingSequence(user) — schedules day 3 & 7 emails via setTimeout
 * (suitable for in-process scheduling; swap with a proper job queue for production at scale)
 *
 * Usage (on signup):
 *   const { sendOnboardingSequence } = require('./scripts/send-onboarding-email');
 *   await sendOnboardingSequence(user); // user: { id, email, user_metadata: { full_name } }
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL    = 'winston@maintmentor.ai';
const APP_URL       = process.env.APP_URL || 'https://maintmentor.ai';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getResend() {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  return new Resend(RESEND_API_KEY);
}

function firstName(user) {
  const name = user?.user_metadata?.full_name || user?.name || user?.email || '';
  return name.split(' ')[0] || 'there';
}

// ─── Email Templates ──────────────────────────────────────────────────────────

function welcomeTemplate(user) {
  const name = firstName(user);
  return {
    subject: '🔧 Welcome to MaintMentor — let\'s get your first fix done',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to MaintMentor</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:16px 16px 0 0;padding:36px 32px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🔧</div>
      <h1 style="color:#f59e0b;font-size:26px;font-weight:800;margin:0 0 8px">MaintMentor</h1>
      <p style="color:#94a3b8;font-size:14px;margin:0">AI-Powered Maintenance Expertise</p>
    </div>

    <!-- Body -->
    <div style="background:#ffffff;padding:36px 32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
      <h2 style="color:#0f172a;font-size:22px;font-weight:700;margin:0 0 16px">
        Welcome aboard, ${name}! 👋
      </h2>
      <p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 20px">
        You've just unlocked 30+ years of maintenance expertise — available 24/7, right in your pocket.
        Whether it's a dripping faucet, a noisy furnace, or something you've never tackled before,
        MaintMentor has your back.
      </p>

      <!-- What you can do -->
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:20px;margin-bottom:24px">
        <h3 style="color:#15803d;font-size:15px;font-weight:700;margin:0 0 12px">✅ What you can do right now:</h3>
        <ul style="color:#166534;font-size:14px;line-height:1.8;margin:0;padding-left:20px">
          <li><strong>Ask the AI anything</strong> — describe a problem and get expert step-by-step guidance</li>
          <li><strong>Upload a photo</strong> — point your camera at the issue and get an instant diagnosis</li>
          <li><strong>Browse the knowledge base</strong> — 1000+ maintenance articles, guides, and checklists</li>
          <li><strong>Earn certifications</strong> — complete tracks to prove your maintenance skills</li>
        </ul>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:28px">
        <a href="${APP_URL}/dashboard"
           style="display:inline-block;background:#f59e0b;color:#0f172a;font-weight:800;font-size:16px;padding:14px 36px;border-radius:12px;text-decoration:none;letter-spacing:0.3px">
          Start Your First Query →
        </a>
      </div>

      <!-- Founding Member box -->
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <p style="color:#92400e;font-size:13px;font-weight:600;margin:0 0 6px">⭐ You're a Founding Member!</p>
        <p style="color:#78350f;font-size:13px;line-height:1.5;margin:0">
          Sign up before <strong>August 17, 2026</strong> to lock in <strong>$19/mo for life</strong>.
          Standard pricing goes to $24.99/mo after the deadline — your rate never changes.
        </p>
      </div>

      <p style="color:#64748b;font-size:14px;line-height:1.6;margin:0">
        Got questions? Just reply to this email — we read every message.<br>
        Let's get things fixed. 🛠️
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center">
      <p style="color:#94a3b8;font-size:12px;margin:0 0 8px">
        MaintMentor · Powered by Google Gemini AI
      </p>
      <p style="color:#cbd5e1;font-size:11px;margin:0">
        You're receiving this because you signed up at maintmentor.ai.
        <a href="${APP_URL}/unsubscribe" style="color:#94a3b8">Unsubscribe</a>
      </p>
    </div>

  </div>
</body>
</html>`,
  };
}

function day3Template(user) {
  const name = firstName(user);
  return {
    subject: '💡 Have you tried the AI yet? (Your MaintMentor is waiting)',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Have you tried the AI yet?</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center">
      <div style="font-size:32px;margin-bottom:6px">💡</div>
      <h1 style="color:#f59e0b;font-size:22px;font-weight:800;margin:0">Quick check-in from MaintMentor</h1>
    </div>

    <!-- Body -->
    <div style="background:#ffffff;padding:32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
      <p style="color:#0f172a;font-size:18px;font-weight:600;margin:0 0 16px">
        Hey ${name} — it's been 3 days! 👋
      </p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        You signed up but we haven't seen you use the AI diagnostic tool yet.
        That's the heart of MaintMentor — and it might just save you a $300 service call.
      </p>

      <!-- Try it now prompt -->
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:24px">
        <h3 style="color:#1d4ed8;font-size:15px;font-weight:700;margin:0 0 12px">🤖 Try asking the AI right now:</h3>
        <ul style="color:#1e40af;font-size:14px;line-height:2;margin:0;padding-left:20px">
          <li>"My AC is blowing warm air — what should I check first?"</li>
          <li>"Why does my water heater make a popping sound?"</li>
          <li>"My toilet runs for 30 seconds after flushing — is that normal?"</li>
        </ul>
      </div>

      <!-- Photo tip -->
      <div style="background:#fdf4ff;border:1px solid #e9d5ff;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <p style="color:#7e22ce;font-size:14px;font-weight:600;margin:0 0 8px">📸 Pro tip: Upload a photo for faster answers</p>
        <p style="color:#6b21a8;font-size:13px;line-height:1.5;margin:0">
          See something weird? Just snap a photo and our AI (powered by Google Gemini) will diagnose it visually.
          Works for leaks, rust, strange equipment markings, and more.
        </p>
      </div>

      <div style="text-align:center;margin-bottom:24px">
        <a href="${APP_URL}/dashboard"
           style="display:inline-block;background:#f59e0b;color:#0f172a;font-weight:800;font-size:16px;padding:14px 36px;border-radius:12px;text-decoration:none">
          Ask MaintMentor Now →
        </a>
      </div>

      <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0">
        No maintenance emergency? No problem — browse the knowledge base, start a certification, or just explore.
        It's all included in your trial. 🛠️
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center">
      <p style="color:#94a3b8;font-size:12px;margin:0">
        MaintMentor · <a href="${APP_URL}/unsubscribe" style="color:#94a3b8">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`,
  };
}

function day7Template(user) {
  const name = firstName(user);
  return {
    subject: '🛠️ Here\'s everything MaintMentor can do for your team (Week 1 recap)',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Week 1 with MaintMentor</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center">
      <div style="font-size:32px;margin-bottom:6px">🛠️</div>
      <h1 style="color:#f59e0b;font-size:22px;font-weight:800;margin:0 0 4px">Your first week with MaintMentor</h1>
      <p style="color:#94a3b8;font-size:13px;margin:0">Here's everything you unlocked</p>
    </div>

    <!-- Body -->
    <div style="background:#ffffff;padding:32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
      <p style="color:#0f172a;font-size:17px;font-weight:600;margin:0 0 16px">
        ${name}, one week in — let's make sure you're getting the most out of MaintMentor.
      </p>

      <!-- Feature grid -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr>
          <td style="padding:12px;background:#f0fdf4;border-radius:10px;width:48%;vertical-align:top">
            <div style="font-size:20px;margin-bottom:6px">🤖</div>
            <strong style="color:#15803d;font-size:14px">AI Diagnostics</strong>
            <p style="color:#166534;font-size:13px;margin:6px 0 0;line-height:1.5">
              Ask any maintenance question. Get expert, step-by-step guidance in seconds.
            </p>
          </td>
          <td style="width:4%"></td>
          <td style="padding:12px;background:#eff6ff;border-radius:10px;width:48%;vertical-align:top">
            <div style="font-size:20px;margin-bottom:6px">📸</div>
            <strong style="color:#1d4ed8;font-size:14px">Photo Analysis</strong>
            <p style="color:#1e40af;font-size:13px;margin:6px 0 0;line-height:1.5">
              Upload photos for visual diagnosis. Powered by Google Gemini Vision.
            </p>
          </td>
        </tr>
        <tr><td colspan="3" style="height:10px"></td></tr>
        <tr>
          <td style="padding:12px;background:#fdf4ff;border-radius:10px;width:48%;vertical-align:top">
            <div style="font-size:20px;margin-bottom:6px">📚</div>
            <strong style="color:#7e22ce;font-size:14px">Knowledge Base</strong>
            <p style="color:#6b21a8;font-size:13px;margin:6px 0 0;line-height:1.5">
              1000+ maintenance guides, checklists, and how-to articles.
            </p>
          </td>
          <td style="width:4%"></td>
          <td style="padding:12px;background:#fff7ed;border-radius:10px;width:48%;vertical-align:top">
            <div style="font-size:20px;margin-bottom:6px">🏆</div>
            <strong style="color:#c2410c;font-size:14px">Certifications</strong>
            <p style="color:#9a3412;font-size:13px;margin:6px 0 0;line-height:1.5">
              Earn 5 verifiable certificates. Prove your maintenance expertise.
            </p>
          </td>
        </tr>
        <tr><td colspan="3" style="height:10px"></td></tr>
        <tr>
          <td colspan="3" style="padding:12px;background:#f8fafc;border-radius:10px;vertical-align:top">
            <div style="font-size:20px;margin-bottom:6px">👥</div>
            <strong style="color:#334155;font-size:14px">Team Management (10+ users)</strong>
            <p style="color:#475569;font-size:13px;margin:6px 0 0;line-height:1.5">
              Bring your whole maintenance crew. Admin dashboard, analytics, and priority support at $12/user/mo.
            </p>
          </td>
        </tr>
      </table>

      <!-- Trial reminder -->
      <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <p style="color:#c2410c;font-size:14px;font-weight:700;margin:0 0 8px">⏰ Your 7-day trial ends today</p>
        <p style="color:#9a3412;font-size:13px;line-height:1.5;margin:0">
          Lock in your <strong>Founding Member rate of $19/mo</strong> before it goes to $24.99 after Aug 17, 2026.
          Your team, your budget, protected — forever.
        </p>
      </div>

      <div style="text-align:center;margin-bottom:24px">
        <a href="${APP_URL}/#pricing"
           style="display:inline-block;background:#f59e0b;color:#0f172a;font-weight:800;font-size:16px;padding:14px 36px;border-radius:12px;text-decoration:none;margin-bottom:12px">
          Upgrade to Pro — $19/mo →
        </a>
        <br>
        <a href="${APP_URL}/dashboard"
           style="display:inline-block;color:#64748b;font-size:13px;text-decoration:underline">
          Keep exploring the trial
        </a>
      </div>

      <p style="color:#64748b;font-size:13px;line-height:1.6;margin:0">
        Questions? Feedback? Just reply — we genuinely want to hear from you.
        Your input shapes what we build next. 🙏
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
</html>`,
  };
}

// ─── Send Functions ───────────────────────────────────────────────────────────

/**
 * Send the welcome email immediately on signup.
 * @param {{ id: string, email: string, user_metadata?: { full_name?: string } }} user
 */
async function sendWelcomeEmail(user) {
  const resend = getResend();
  const { subject, html } = welcomeTemplate(user);
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to:   user.email,
    subject,
    html,
  });
  console.log(`[onboarding] Welcome email sent to ${user.email}`, result?.id || '');
  return result;
}

/**
 * Send the Day 3 follow-up email.
 * @param {{ id: string, email: string, user_metadata?: { full_name?: string } }} user
 */
async function sendDay3FollowUp(user) {
  const resend = getResend();
  const { subject, html } = day3Template(user);
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to:   user.email,
    subject,
    html,
  });
  console.log(`[onboarding] Day-3 follow-up sent to ${user.email}`, result?.id || '');
  return result;
}

/**
 * Send the Day 7 check-in email.
 * @param {{ id: string, email: string, user_metadata?: { full_name?: string } }} user
 */
async function sendDay7CheckIn(user) {
  const resend = getResend();
  const { subject, html } = day7Template(user);
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to:   user.email,
    subject,
    html,
  });
  console.log(`[onboarding] Day-7 check-in sent to ${user.email}`, result?.id || '');
  return result;
}

/**
 * Full onboarding sequence: send welcome now, schedule day-3 and day-7 emails.
 *
 * NOTE: Uses setTimeout for in-process scheduling.
 * For production scale, replace with a proper job queue (BullMQ, etc.)
 * or a Supabase Edge Function scheduler.
 *
 * @param {{ id: string, email: string, user_metadata?: { full_name?: string } }} user
 */
async function sendOnboardingSequence(user) {
  // Welcome — fire immediately
  try {
    await sendWelcomeEmail(user);
  } catch (err) {
    console.error('[onboarding] Failed to send welcome email:', err.message);
  }

  // Day 3 — schedule in 3 days (72h)
  const DAY3_MS = 3 * 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    try {
      await sendDay3FollowUp(user);
    } catch (err) {
      console.error('[onboarding] Failed to send day-3 email:', err.message);
    }
  }, DAY3_MS);

  // Day 7 — schedule in 7 days (168h)
  const DAY7_MS = 7 * 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    try {
      await sendDay7CheckIn(user);
    } catch (err) {
      console.error('[onboarding] Failed to send day-7 email:', err.message);
    }
  }, DAY7_MS);

  console.log(`[onboarding] Sequence queued for ${user.email} (welcome now, day-3 in 72h, day-7 in 168h)`);
}

// ─── Weekly Progress Email ────────────────────────────────────────────────────────────

/**
 * Build HTML for weekly progress email.
 */
function weeklyProgressTemplate({ user, stats, nextLesson }) {
  const name = firstName(user);
  const {
    lessons_completed = 0,
    queries_asked     = 0,
    credits_used      = 0,
    tracks_in_progress = 0,
  } = stats || {};

  const nextLessonBlock = nextLesson
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <p style="color:#1d4ed8;font-size:14px;font-weight:600;margin:0 0 6px">➡️ Up next for you:</p>
        <p style="color:#1e40af;font-size:15px;font-weight:700;margin:0 0 4px">${nextLesson.title}</p>
        <p style="color:#3b82f6;font-size:13px;margin:0 0 12px">${nextLesson.track || ''}</p>
        <a href="${APP_URL}/certifications" style="display:inline-block;background:#3b82f6;color:#fff;font-weight:700;font-size:13px;padding:8px 20px;border-radius:8px;text-decoration:none">Continue Learning →</a>
      </div>`
    : '';

  return {
    subject: `📊 Your MaintMentor week in review`,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center">
      <div style="font-size:32px;margin-bottom:6px">📊</div>
      <h1 style="color:#f59e0b;font-size:22px;font-weight:800;margin:0 0 4px">Weekly Progress</h1>
      <p style="color:#94a3b8;font-size:13px;margin:0">Your MaintMentor summary</p>
    </div>
    <div style="background:#fff;padding:32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
      <p style="color:#0f172a;font-size:17px;font-weight:600;margin:0 0 20px">Hey ${name}! Here's your week at a glance 👋</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr>
          <td style="padding:14px;background:#f0fdf4;border-radius:10px;text-align:center;width:30%">
            <div style="font-size:28px;font-weight:800;color:#15803d">${lessons_completed}</div>
            <div style="font-size:12px;color:#166534;margin-top:4px">Lessons<br>Completed</div>
          </td>
          <td style="width:5%"></td>
          <td style="padding:14px;background:#eff6ff;border-radius:10px;text-align:center;width:30%">
            <div style="font-size:28px;font-weight:800;color:#1d4ed8">${queries_asked}</div>
            <div style="font-size:12px;color:#1e40af;margin-top:4px">AI Queries<br>Asked</div>
          </td>
          <td style="width:5%"></td>
          <td style="padding:14px;background:#fdf4ff;border-radius:10px;text-align:center;width:30%">
            <div style="font-size:28px;font-weight:800;color:#7e22ce">${credits_used}</div>
            <div style="font-size:12px;color:#6b21a8;margin-top:4px">Credits<br>Used</div>
          </td>
        </tr>
      </table>
      ${nextLessonBlock}
      <div style="text-align:center;margin-bottom:24px">
        <a href="${APP_URL}/dashboard" style="display:inline-block;background:#f59e0b;color:#0f172a;font-weight:800;font-size:15px;padding:12px 32px;border-radius:10px;text-decoration:none">Open Dashboard →</a>
      </div>
    </div>
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center">
      <p style="color:#94a3b8;font-size:12px;margin:0">MaintMentor · <a href="${APP_URL}/unsubscribe" style="color:#94a3b8">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`,
  };
}

/**
 * Send a weekly progress email for a single user.
 *
 * @param {string} userId  — Supabase user ID
 * Fetches user profile, weekly stats from Supabase, and sends the email.
 */
async function sendWeeklyProgressEmail(userId) {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[weekly-email] Missing Supabase credentials');
    return;
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Get user profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', userId)
    .maybeSingle();

  if (!profile?.email) {
    console.warn(`[weekly-email] No profile/email for user ${userId}`);
    return;
  }

  const user = { email: profile.email, user_metadata: { full_name: profile.full_name } };

  // Get weekly stats
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Queries asked this week (from query_logs if available)
  let queriesAsked = 0;
  try {
    const { count } = await supabase
      .from('query_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', oneWeekAgo);
    queriesAsked = count || 0;
  } catch (_) {}

  // Lessons completed this week
  let lessonsCompleted = 0;
  let nextLesson = null;
  try {
    const { count } = await supabase
      .from('lesson_progress')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('completed_at', oneWeekAgo);
    lessonsCompleted = count || 0;

    // Next recommended lesson = first incomplete lesson in any track
    const { data: nextItems } = await supabase
      .from('lesson_progress')
      .select('lesson_id')
      .eq('user_id', userId)
      .eq('completed', false)
      .limit(1);
    if (nextItems?.[0]) {
      const { data: lesson } = await supabase
        .from('lessons')
        .select('title, track_id')
        .eq('id', nextItems[0].lesson_id)
        .maybeSingle();
      if (lesson) nextLesson = { title: lesson.title };
    }
  } catch (_) {}

  // Credits used this week
  let creditsUsed = 0;
  try {
    const { data: txns } = await supabase
      .from('wallet_transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('type', 'debit')
      .gte('created_at', oneWeekAgo);
    creditsUsed = (txns || []).reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
  } catch (_) {}

  const stats = {
    lessons_completed: lessonsCompleted,
    queries_asked:     queriesAsked,
    credits_used:      creditsUsed,
  };

  const resend = getResend();
  const { subject, html } = weeklyProgressTemplate({ user, stats, nextLesson });

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to:   profile.email,
    subject,
    html,
  });

  console.log(`[weekly-email] Sent to ${profile.email}:`, result?.id || '');
  return result;
}

module.exports = {
  sendWelcomeEmail,
  sendDay3FollowUp,
  sendDay7CheckIn,
  sendOnboardingSequence,
  sendWeeklyProgressEmail,
};

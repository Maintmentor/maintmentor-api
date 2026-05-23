#!/usr/bin/env node
/**
 * MaintMentor.ai — Trial Drip Email Sequence
 * Run via cron: 0 14 * * * node /root/maintmentor-api/drip-emails.js
 * (2pm UTC = 10am ET)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./notifications');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
);

const DRIP_EMAILS = [
  {
    day: 1,
    subject: '🔧 Welcome to MaintMentor — here\'s how to get the most out of your trial',
    html: (name) => `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
        <div style="background:#0f172a;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
          <span style="color:white;font-size:20px;font-weight:800;">MaintMentor<span style="color:#f59e0b;">.ai</span></span>
        </div>
        <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
          <h2>Welcome${name ? ', ' + name : ''}! 👋</h2>
          <p style="line-height:1.7;">You've got 7 days to explore everything MaintMentor has to offer. Here's how to make the most of it:</p>
          <h3 style="color:#f59e0b;">Try these first:</h3>
          <ul style="line-height:2;">
            <li><strong>Ask the AI mentor</strong> — Type any maintenance question or upload a photo of a problem</li>
            <li><strong>Try photo diagnosis</strong> — Snap a pic of an error code, a broken part, or damage</li>
            <li><strong>Start a certification</strong> — 5 professional tracks with quizzes and certificates</li>
          </ul>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://maintmentor.ai/dashboard" style="background:#f59e0b;color:#0f172a;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;">Open MaintMentor</a>
          </div>
          <p style="font-size:13px;color:#64748b;">Questions? Just reply to this email or call 1-352-575-3472.</p>
          <p style="margin-top:16px;">— Dean Richards, Founder<br><em>30+ years in residential maintenance</em></p>
        </div>
      </div>
    `,
  },
  {
    day: 3,
    subject: '🎓 Did you know? You have 5 professional certifications included',
    html: (name) => `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
        <div style="background:#0f172a;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
          <span style="color:white;font-size:20px;font-weight:800;">MaintMentor<span style="color:#f59e0b;">.ai</span></span>
        </div>
        <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
          <h2>Your certifications are waiting${name ? ', ' + name : ''} 🎓</h2>
          <p style="line-height:1.7;">Most maintenance training platforms charge $30-50/month for certification courses. Yours are included free with your MaintMentor subscription.</p>
          <h3 style="color:#f59e0b;">5 Certification Tracks:</h3>
          <ul style="line-height:2;">
            <li>⚡ Electrical Safety & Fundamentals</li>
            <li>❄️ HVAC Systems</li>
            <li>🚿 Plumbing Essentials</li>
            <li>🔧 Appliance Repair</li>
            <li>🏠 General Maintenance</li>
          </ul>
          <p style="line-height:1.7;">Each track has interactive lessons, timed quizzes, and a <strong>printable certificate</strong> when you pass. Built from real field experience — not textbook theory.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://maintmentor.ai/certifications" style="background:#f59e0b;color:#0f172a;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;">Start a Certification</a>
          </div>
          <p style="font-size:13px;color:#64748b;">Your trial has 4 days left. Lock in $19/mo for life before August 17.</p>
        </div>
      </div>
    `,
  },
  {
    day: 5,
    subject: '📸 Pro tip: Upload a photo and watch the magic happen',
    html: (name) => `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
        <div style="background:#0f172a;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
          <span style="color:white;font-size:20px;font-weight:800;">MaintMentor<span style="color:#f59e0b;">.ai</span></span>
        </div>
        <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
          <h2>The feature techs love most${name ? ', ' + name : ''} 📸</h2>
          <p style="line-height:1.7;">Next time you're on a call and you're not sure what you're looking at — <strong>snap a photo and upload it to MaintMentor.</strong></p>
          <p style="line-height:1.7;">The AI will:</p>
          <ul style="line-height:2;">
            <li>Identify the equipment, part, or issue</li>
            <li>Give you step-by-step repair instructions</li>
            <li>Tell you what parts you need and where to find them</li>
            <li>Work in 30+ languages for your whole crew</li>
          </ul>
          <p style="line-height:1.7;">Try it with an error code on an HVAC unit, a leaking pipe fitting, or a tripped breaker panel. It's like having a 30-year veteran looking over your shoulder.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://maintmentor.ai/dashboard" style="background:#f59e0b;color:#0f172a;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;">Try Photo Diagnosis</a>
          </div>
          <p style="font-size:13px;color:#64748b;">2 days left on your trial!</p>
        </div>
      </div>
    `,
  },
  {
    day: 7,
    subject: '⏰ Your trial ends tomorrow — lock in $19/mo for life',
    html: (name) => `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
        <div style="background:#0f172a;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
          <span style="color:white;font-size:20px;font-weight:800;">MaintMentor<span style="color:#f59e0b;">.ai</span></span>
        </div>
        <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
          <h2>Your trial ends tomorrow${name ? ', ' + name : ''} ⏰</h2>
          <p style="line-height:1.7;">Your 7-day free trial of MaintMentor.ai is almost up. Here's what you'll keep when you subscribe:</p>
          <ul style="line-height:2;">
            <li>✅ Unlimited AI diagnostic chat</li>
            <li>✅ 200 queries + 50 photo analyses per month</li>
            <li>✅ 5 professional certification tracks</li>
            <li>✅ Full knowledge base & video library</li>
            <li>✅ All your conversation history preserved</li>
          </ul>
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px;text-align:center;margin:16px 0;">
            <p style="font-size:18px;font-weight:900;margin-bottom:4px;">⭐ Founding Member: $19/mo for life</p>
            <p style="font-size:13px;color:#92400e;">Regular price goes to $24.99/mo after August 17, 2026</p>
          </div>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://maintmentor.ai/#pricing" style="background:#f59e0b;color:#0f172a;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;">Subscribe Now — $19/mo</a>
          </div>
          <p style="font-size:13px;color:#64748b;">Questions? Call me directly: 1-352-575-3472</p>
          <p style="margin-top:16px;">— Dean Richards, Founder</p>
        </div>
      </div>
    `,
  },
];

async function runDripEmails() {
  console.log(`[drip] Starting drip email run at ${new Date().toISOString()}`);
  
  // Get all trial users with their signup dates
  const { data: trialUsers, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, created_at, subscription_status')
    .eq('subscription_status', 'trial');
  
  if (error) {
    console.error('[drip] Failed to fetch trial users:', error.message);
    return;
  }
  
  if (!trialUsers || trialUsers.length === 0) {
    console.log('[drip] No trial users found');
    return;
  }
  
  console.log(`[drip] Found ${trialUsers.length} trial users`);
  
  const now = new Date();
  
  for (const user of trialUsers) {
    const signupDate = new Date(user.created_at);
    const daysSinceSignup = Math.floor((now.getTime() - signupDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Find matching drip email for this day
    const drip = DRIP_EMAILS.find(d => d.day === daysSinceSignup);
    if (!drip) continue;
    
    // Check if we already sent this drip (prevent duplicates)
    const dripKey = `drip_day${drip.day}_${user.id}`;
    const { data: existing } = await supabase
      .from('drip_log')
      .select('id')
      .eq('key', dripKey)
      .maybeSingle();
    
    if (existing) {
      console.log(`[drip] Already sent day ${drip.day} to ${user.email} — skipping`);
      continue;
    }
    
    // Send the email
    const name = user.full_name?.split(' ')[0] || '';
    try {
      await sendEmail(drip.subject, drip.html(name));
      console.log(`[drip] ✅ Sent day ${drip.day} email to ${user.email}`);
      
      // Log it
      await supabase.from('drip_log').insert({
        key: dripKey,
        user_id: user.id,
        drip_day: drip.day,
        sent_at: now.toISOString(),
      }).catch(() => {}); // Non-critical if log fails
    } catch (err) {
      console.error(`[drip] ❌ Failed to send day ${drip.day} to ${user.email}:`, err.message);
    }
  }
  
  console.log('[drip] Drip run complete');
}

runDripEmails().catch(err => {
  console.error('[drip] Fatal error:', err.message);
  process.exit(1);
});

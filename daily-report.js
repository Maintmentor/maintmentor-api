#!/usr/bin/env node
/**
 * MaintMentor.ai — Daily Usage Report
 * Run via cron: 0 13 * * * node /root/maintmentor-api/daily-report.js
 * (1pm UTC = 9am ET — Dean's morning coffee time)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./notifications');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
);

async function generateReport() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const todayStr = now.toISOString().split('T')[0];

  // Total users
  const { count: totalUsers } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true });

  // New signups (last 24h)
  const { count: newSignups } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', yesterday.toISOString());

  // Active subscribers
  const { count: activeSubscribers } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('subscription_status', 'active');

  // Trial users
  const { count: trialUsers } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('subscription_status', 'trial');

  // Conversations today
  const { count: todayConversations } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', yesterday.toISOString());

  // Messages today
  const { count: todayMessages } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', yesterday.toISOString());

  // Total conversations ever
  const { count: totalConversations } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true });

  // Total messages ever
  const { count: totalMessages } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true });

  // Certification progress
  const { count: certEnrollments } = await supabase
    .from('user_certifications')
    .select('id', { count: 'exact', head: true });

  const { count: completedCerts } = await supabase
    .from('user_certifications')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed');

  const dateDisplay = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });

  const subject = `📊 MaintMentor Daily Report — ${dateDisplay}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #0f172a;">📊 Daily Report — ${dateDisplay}</h2>
      
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #f59e0b; color: #0f172a;">
          <th style="padding: 10px; text-align: left;" colspan="2">👥 Users</th>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Total Users</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${totalUsers || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">New Signups (24h)</td>
          <td style="padding: 8px; font-weight: bold; text-align: right; color: ${(newSignups || 0) > 0 ? '#16a34a' : '#64748b'};">${newSignups || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Active Subscribers</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${activeSubscribers || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Trial Users</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${trialUsers || 0}</td>
        </tr>
      </table>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #0f172a; color: white;">
          <th style="padding: 10px; text-align: left;" colspan="2">💬 AI Chat Activity</th>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Conversations (24h)</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${todayConversations || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Messages (24h)</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${todayMessages || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Total Conversations (all time)</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${totalConversations || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Total Messages (all time)</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${totalMessages || 0}</td>
        </tr>
      </table>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #16a34a; color: white;">
          <th style="padding: 10px; text-align: left;" colspan="2">🎓 Certifications</th>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Enrollments</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${certEnrollments || 0}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px;">Completed</td>
          <td style="padding: 8px; font-weight: bold; text-align: right;">${completedCerts || 0}</td>
        </tr>
      </table>

      <p style="color: #64748b; font-size: 12px; margin-top: 20px;">
        — Winston 🔧 | MaintMentor.ai COO<br>
        <em>This report runs automatically every morning at 9am ET.</em>
      </p>
    </div>
  `;

  await sendEmail(subject, html);
  console.log('[daily-report] Report sent successfully');
}

generateReport().catch(err => {
  console.error('[daily-report] Failed:', err.message);
  process.exit(1);
});

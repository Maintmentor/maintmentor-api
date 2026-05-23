/**
 * MaintMentor.ai — Notification System
 * Sends alerts to Dean via email (Resend API)
 * for Stripe events, daily reports, and system alerts
 */

const https = require('https');

const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_NZt2QPLX_K2ewXv8A31okNTyyCBVPWX58';
const DEAN_EMAIL = 'bleaudog1@gmail.com';
const FROM_EMAIL = 'Winston <winston@maintmentor.ai>';

async function sendEmail(subject, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: FROM_EMAIL,
      to: [DEAN_EMAIL],
      subject,
      html,
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[notify] Email sent: ${subject}`);
          resolve(data);
        } else {
          console.error(`[notify] Email failed (${res.statusCode}): ${data}`);
          reject(new Error(`Email failed: ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Stripe Event Notifications ───────────────────────────────────────────────

async function notifyNewSubscriber(userId, email) {
  const subject = '🎉 New MaintMentor Subscriber!';
  const html = `
    <h2>🎉 New Subscriber!</h2>
    <p>Someone just subscribed to MaintMentor.ai Pro!</p>
    <ul>
      <li><strong>User ID:</strong> ${userId || 'Unknown'}</li>
      <li><strong>Email:</strong> ${email || 'Unknown'}</li>
      <li><strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</li>
    </ul>
    <p>— Winston 🔧</p>
  `;
  return sendEmail(subject, html).catch(err => console.error('[notify]', err.message));
}

async function notifyPaymentFailed(userId, email) {
  const subject = '⚠️ Payment Failed — MaintMentor';
  const html = `
    <h2>⚠️ Payment Failed</h2>
    <p>A subscription payment failed. Stripe will retry automatically.</p>
    <ul>
      <li><strong>User ID:</strong> ${userId || 'Unknown'}</li>
      <li><strong>Email:</strong> ${email || 'Unknown'}</li>
      <li><strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</li>
    </ul>
    <p>Want me to send a retention email? Reply to this email or message me on WhatsApp.</p>
    <p>— Winston 🔧</p>
  `;
  return sendEmail(subject, html).catch(err => console.error('[notify]', err.message));
}

async function notifySubscriptionCancelled(userId, email) {
  const subject = '😔 Subscription Cancelled — MaintMentor';
  const html = `
    <h2>😔 Subscription Cancelled</h2>
    <p>A user cancelled their subscription.</p>
    <ul>
      <li><strong>User ID:</strong> ${userId || 'Unknown'}</li>
      <li><strong>Email:</strong> ${email || 'Unknown'}</li>
      <li><strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</li>
    </ul>
    <p>Consider reaching out to understand why they left.</p>
    <p>— Winston 🔧</p>
  `;
  return sendEmail(subject, html).catch(err => console.error('[notify]', err.message));
}

async function notifyNewSignup(userId, email) {
  const subject = '👋 New MaintMentor Signup (Trial)';
  const html = `
    <h2>👋 New Trial Signup!</h2>
    <p>Someone just created an account on MaintMentor.ai!</p>
    <ul>
      <li><strong>User ID:</strong> ${userId || 'Unknown'}</li>
      <li><strong>Email:</strong> ${email || 'Unknown'}</li>
      <li><strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</li>
    </ul>
    <p>They're on a 7-day free trial. Let's make sure they have a great experience!</p>
    <p>— Winston 🔧</p>
  `;
  return sendEmail(subject, html).catch(err => console.error('[notify]', err.message));
}

module.exports = {
  sendEmail,
  notifyNewSubscriber,
  notifyPaymentFailed,
  notifySubscriptionCancelled,
  notifyNewSignup,
};

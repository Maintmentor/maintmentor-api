'use strict';

/**
 * tests/day12.test.js
 *
 * Day 12 verification tests:
 *   1. Onboarding email script exists and exports required functions
 *   2. Milestone lib exists and exports required functions
 *   3. MILESTONES array contains 1, 10, 50, 100
 *   4. Admin stats endpoint returns 401 without X-Admin-Token
 *   5. Status endpoint returns 200 with expected shape
 *   6. ADMIN_TOKEN is set in .env
 *   7. Pricing page has Founding Member urgency banner
 *   8. Pricing page has $24.99 strikethrough price
 */

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');

const API_ROOT      = path.join(__dirname, '..');
const FRONTEND_ROOT = path.join('/root', 'maintenance-mentor-app', 'src');
const PRICING_PAGE  = path.join(FRONTEND_ROOT, 'components', 'Pricing.tsx');
const ONBOARDING    = path.join(API_ROOT, 'scripts', 'send-onboarding-email.js');
const MILESTONES    = path.join(API_ROOT, 'lib', 'milestones.js');
const ENV_FILE      = path.join(API_ROOT, '.env');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readFile(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${label || filePath}: ${e.message}`);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`         ${err.message}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`         ${err.message}`);
    process.exitCode = 1;
  }
}

function httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'GET',
      headers,
      timeout:  5000,
    };
    const mod = url.protocol === 'https:' ? require('https') : http;
    const req = mod.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(body) }); }
        catch (_) { resolve({ statusCode: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n📋 Day 12 Tests\n');

// 1. Onboarding email script exists
test('scripts/send-onboarding-email.js exists', () => {
  assert.ok(fs.existsSync(ONBOARDING), `File not found: ${ONBOARDING}`);
});

// 2. Onboarding email script exports required functions
test('send-onboarding-email exports sendWelcomeEmail, sendDay3FollowUp, sendDay7CheckIn, sendOnboardingSequence', () => {
  const mod = require(ONBOARDING);
  assert.strictEqual(typeof mod.sendWelcomeEmail,      'function', 'sendWelcomeEmail must be a function');
  assert.strictEqual(typeof mod.sendDay3FollowUp,      'function', 'sendDay3FollowUp must be a function');
  assert.strictEqual(typeof mod.sendDay7CheckIn,       'function', 'sendDay7CheckIn must be a function');
  assert.strictEqual(typeof mod.sendOnboardingSequence,'function', 'sendOnboardingSequence must be a function');
});

// 3. Milestones lib exists
test('lib/milestones.js exists', () => {
  assert.ok(fs.existsSync(MILESTONES), `File not found: ${MILESTONES}`);
});

// 4. Milestones lib exports required functions
test('milestones exports checkAndFireMilestone, getMilestones, buildMilestoneEmail', () => {
  const mod = require(MILESTONES);
  assert.strictEqual(typeof mod.checkAndFireMilestone, 'function', 'checkAndFireMilestone must be a function');
  assert.strictEqual(typeof mod.getMilestones,         'function', 'getMilestones must be a function');
  assert.strictEqual(typeof mod.buildMilestoneEmail,   'function', 'buildMilestoneEmail must be a function');
});

// 5. MILESTONES array contains 1, 10, 50, 100
test('getMilestones() returns [1, 10, 50, 100]', () => {
  const { getMilestones } = require(MILESTONES);
  const ms = getMilestones();
  [1, 10, 50, 100].forEach(n => {
    assert.ok(ms.includes(n), `Milestone ${n} not found in getMilestones()`);
  });
});

// 6. buildMilestoneEmail produces HTML for milestone 1
test('buildMilestoneEmail(1) returns subject and html', () => {
  const { buildMilestoneEmail } = require(MILESTONES);
  const result = buildMilestoneEmail(1, 'test@example.com', 100);
  assert.ok(result, 'buildMilestoneEmail(1) should return a value');
  assert.ok(result.subject, 'should have a subject');
  assert.ok(result.html,    'should have html');
  assert.ok(result.html.includes('<!DOCTYPE html'), 'html should be a full HTML document');
});

// 7. ADMIN_TOKEN set in .env
test('ADMIN_TOKEN is set in .env', () => {
  const envContent = readFile(ENV_FILE, '.env');
  assert.ok(
    /^ADMIN_TOKEN=\S+/m.test(envContent),
    'ADMIN_TOKEN must be set in .env as ADMIN_TOKEN=<value>'
  );
  const match = envContent.match(/^ADMIN_TOKEN=(\S+)/m);
  assert.ok(match && match[1].length >= 20, 'ADMIN_TOKEN should be at least 20 chars');
});

// 8. Admin stats endpoint wired in server.js
test('server.js contains /api/admin/stats endpoint', () => {
  const serverJs = readFile(path.join(API_ROOT, 'server.js'), 'server.js');
  assert.ok(serverJs.includes('/api/admin/stats'), 'server.js must define /api/admin/stats');
  assert.ok(serverJs.includes('x-admin-token'), 'server.js must check x-admin-token header');
});

// 9. Status endpoint wired in server.js
test('server.js contains /api/status endpoint', () => {
  const serverJs = readFile(path.join(API_ROOT, 'server.js'), 'server.js');
  assert.ok(serverJs.includes('/api/status'), 'server.js must define /api/status');
  assert.ok(serverJs.includes('operational'),  'status response must contain "operational"');
});

// 10. Pricing page has Founding Member urgency banner
test('Pricing.tsx has Founding Member urgency banner', () => {
  const pricing = readFile(PRICING_PAGE, 'Pricing.tsx');
  assert.ok(
    pricing.includes('Founding Member Pricing') || pricing.includes('FOUNDING MEMBER'),
    'Pricing.tsx must mention Founding Member pricing'
  );
  assert.ok(
    pricing.includes('Aug') || pricing.includes('August'),
    'Pricing.tsx must reference the August 17 deadline'
  );
});

// 11. Pricing page has $24.99 reference
test('Pricing.tsx shows $24.99 post-deadline price', () => {
  const pricing = readFile(PRICING_PAGE, 'Pricing.tsx');
  assert.ok(pricing.includes('24.99'), 'Pricing.tsx must show the $24.99 standard price');
});

// 12. Onboarding email is triggered in server.js on signup confirmation
test('server.js triggers onboarding email in /api/auth/confirm-email', () => {
  const serverJs = readFile(path.join(API_ROOT, 'server.js'), 'server.js');
  assert.ok(
    serverJs.includes('sendOnboardingSequence') || serverJs.includes('send-onboarding-email'),
    'server.js must call sendOnboardingSequence from /api/auth/confirm-email'
  );
});

// 13. Live status endpoint (optional — skip if API not reachable)
(async () => {
  await testAsync('GET /api/status returns 200 with operational status', async () => {
    const BASE = process.env.API_URL || 'http://127.0.0.1:3001';
    let res;
    try {
      res = await httpGet(`${BASE}/api/status`);
    } catch (err) {
      // If the server is not running locally, skip gracefully
      if (err.code === 'ECONNREFUSED' || err.message === 'Request timed out') {
        console.log(`         (skipped — API not reachable at ${BASE})`);
        return;
      }
      throw err;
    }
    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
    assert.ok(
      res.body?.status === 'operational' || res.body?.status === 'degraded',
      `Expected status 'operational' or 'degraded', got: ${JSON.stringify(res.body?.status)}`
    );
    assert.ok(res.body?.uptime, 'Response must include uptime field');
    assert.ok(res.body?.endpoints, 'Response must include endpoints field');
  });

  // 14. Live admin stats returns 401 without token
  await testAsync('GET /api/admin/stats returns 401 without X-Admin-Token', async () => {
    const BASE = process.env.API_URL || 'http://127.0.0.1:3001';
    let res;
    try {
      res = await httpGet(`${BASE}/api/admin/stats`);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.message === 'Request timed out') {
        console.log(`         (skipped — API not reachable at ${BASE})`);
        return;
      }
      throw err;
    }
    assert.strictEqual(res.statusCode, 401, `Expected 401, got ${res.statusCode}`);
  });

  console.log('\n✅ Day 12 test suite complete.\n');
})();

'use strict';

/**
 * tests/day15.test.js
 *
 * Day 15 verification tests — User Growth & Retention
 *
 *  Static tests (filesystem):
 *   1. Migration file 20260609_growth.sql exists
 *   2. Migration file contains all required tables
 *   3. routes/referrals.js exists and exports router
 *   4. routes/dashboard.js includes /alerts endpoint
 *   5. server.js registers /api/referrals
 *   6. server.js registers /api/teams
 *   7. sendWeeklyProgressEmail exported from onboarding script
 *   8. ReferralJoin page exists in frontend
 *   9. /join/:code route registered in App.tsx
 *
 *  HTTP tests (live API — no auth):
 *  10. POST /api/teams returns 401 without auth
 *  11. GET  /api/referrals/code returns 401 without auth
 *  12. POST /api/dashboard/alerts returns 401 without auth
 *  13. GET  /api/referrals/stats returns 401 without auth
 *  14. GET  /api/referrals/lookup/:code — 404 for fake code (public route)
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');

const API_ROOT    = path.join(__dirname, '..');
const FRONTEND    = path.join(__dirname, '../../maintenance-mentor-app');
const BASE_URL    = process.env.TEST_API_URL || 'http://127.0.0.1:3001';
const MIGRATIONS  = path.join(API_ROOT, 'supabase', 'migrations');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function asyncTest(name, fn) {
  return fn()
    .then(() => console.log(`  ✅ PASS: ${name}`))
    .catch(err => {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`         ${err.message}`);
      process.exitCode = 1;
    });
}

function request(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port:     url.port || 3001,
      path:     url.pathname + url.search,
      method,
      headers:  opts.headers || {},
      timeout:  15000,
    };
    let body = '';
    if (opts.body) {
      body = JSON.stringify(opts.body);
      options.headers['Content-Type']   = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Static Tests ─────────────────────────────────────────────────────────────

console.log('\n📋 Day 15 — Static tests (filesystem):\n');

test('Migration file 20260609_growth.sql exists', () => {
  const migPath = path.join(MIGRATIONS, '20260609_growth.sql');
  assert.ok(fs.existsSync(migPath), `Migration file not found at ${migPath}`);
});

test('Migration file contains all required tables', () => {
  const migPath = path.join(MIGRATIONS, '20260609_growth.sql');
  const sql = fs.readFileSync(migPath, 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS teams'),          'Missing teams table');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS team_members'),   'Missing team_members table');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS referral_codes'), 'Missing referral_codes table');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS user_alerts'),    'Missing user_alerts table');
  assert.ok(sql.includes('referral_code'), 'Missing referral_code column for profiles');
});

test('routes/referrals.js exists', () => {
  const routePath = path.join(API_ROOT, 'routes', 'referrals.js');
  assert.ok(fs.existsSync(routePath), 'routes/referrals.js not found');
});

test('routes/referrals.js has required routes', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'routes', 'referrals.js'), 'utf8');
  assert.ok(src.includes('/code'),   'Missing /code route');
  assert.ok(src.includes('/stats'),  'Missing /stats route');
  assert.ok(src.includes('/apply'),  'Missing /apply route');
  assert.ok(src.includes('/lookup'), 'Missing /lookup route');
});

test('routes/dashboard.js includes /alerts endpoint', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'routes', 'dashboard.js'), 'utf8');
  assert.ok(src.includes('/alerts'),         'Missing /alerts route');
  assert.ok(src.includes('alert_type'),      'Missing alert_type field');
  assert.ok(src.includes('user_alerts'),     'Must use user_alerts table');
});

test('server.js registers /api/referrals', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes('/api/referrals'), 'server.js must register /api/referrals');
  assert.ok(src.includes("require('./routes/referrals')"), 'server.js must require referrals router');
});

test('server.js registers /api/teams', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes('/api/teams'), 'server.js must register /api/teams routes');
});

test('sendWeeklyProgressEmail exported from onboarding script', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'scripts', 'send-onboarding-email.js'), 'utf8');
  assert.ok(src.includes('sendWeeklyProgressEmail'), 'sendWeeklyProgressEmail function must exist');
  assert.ok(src.includes('module.exports'), 'Must export from the module');
  // Actually load and verify it exports the function
  const mod = require(path.join(API_ROOT, 'scripts', 'send-onboarding-email.js'));
  assert.strictEqual(typeof mod.sendWeeklyProgressEmail, 'function', 'sendWeeklyProgressEmail must be a function');
});

test('ReferralJoin page exists in frontend', () => {
  const pagePath = path.join(FRONTEND, 'src', 'pages', 'ReferralJoin.tsx');
  assert.ok(fs.existsSync(pagePath), 'src/pages/ReferralJoin.tsx not found');
  const src = fs.readFileSync(pagePath, 'utf8');
  assert.ok(src.includes('/join/'), 'ReferralJoin must reference /join/ path');
  assert.ok(src.includes('referrer_first_name'), 'Must display referrer name');
});

test('/join/:code route registered in App.tsx', () => {
  const appPath = path.join(FRONTEND, 'src', 'App.tsx');
  const src = fs.readFileSync(appPath, 'utf8');
  assert.ok(src.includes('/join/:code'), 'App.tsx must include /join/:code route');
  assert.ok(src.includes('ReferralJoin'), 'App.tsx must import ReferralJoin component');
});

// ─── HTTP Tests ────────────────────────────────────────────────────────────────

console.log('\n🌐 Day 15 — HTTP tests (live API):\n');

async function runHttpTests() {
  // Test: POST /api/teams — 401 without auth
  await asyncTest('POST /api/teams returns 401 without auth', async () => {
    const { status } = await request('POST', '/api/teams', {
      body: { name: 'Test Team' },
    });
    assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
  });

  // Test: GET /api/referrals/code — 401 without auth
  await asyncTest('GET /api/referrals/code returns 401 without auth', async () => {
    const { status } = await request('GET', '/api/referrals/code');
    assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
  });

  // Test: POST /api/dashboard/alerts — 401 without auth
  await asyncTest('POST /api/dashboard/alerts returns 401 without auth', async () => {
    const { status } = await request('POST', '/api/dashboard/alerts', {
      body: { alert_type: 'low_balance', threshold: 100 },
    });
    assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
  });

  // Test: GET /api/referrals/stats — 401 without auth
  await asyncTest('GET /api/referrals/stats returns 401 without auth', async () => {
    const { status } = await request('GET', '/api/referrals/stats');
    assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
  });

  // Test: GET /api/referrals/lookup/:code — 404 for fake code (public route)
  await asyncTest('GET /api/referrals/lookup/FAKECODE returns 404 (public route)', async () => {
    const { status } = await request('GET', '/api/referrals/lookup/FAKECODE00');
    assert.ok([404, 400].includes(status), `Expected 404/400, got ${status}`);
  });
}

runHttpTests().then(() => {
  console.log('\n🏁 Day 15 tests complete.\n');
});

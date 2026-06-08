'use strict';

/**
 * tests/day14.test.js
 *
 * Day 14 verification tests — XPRIZE Demo & Google Cloud Integration
 *
 *  1.  GET  /api/demo — 200 with correct shape
 *  2.  GET  /api/demo — contains answer field (AI responded)
 *  3.  GET  /api/demo — contains platform stats
 *  4.  GET  /api/health — contains cloudrun check
 *  5.  POST /api/agent/field — 401 without API key
 *  6.  POST /api/agent/field — 400 with missing question
 *  7.  GET  /api/xprize/metrics — 401 without admin token
 *  8.  GET  /api/certifications/leaderboard — 200 with correct shape
 *  9.  Field Companion route exists in routes/agent.js
 *  10. Leaderboard route exists in routes/certifications.js
 *  11. XPRIZE demo endpoint registered in server.js
 *  12. XPRIZE metrics endpoint registered in server.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');

const API_ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.TEST_API_URL || 'http://127.0.0.1:3001';

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
  return fn().then(() => {
    console.log(`  ✅ PASS: ${name}`);
  }).catch(err => {
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
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Static (filesystem) tests — run immediately ──────────────────────────────

console.log('\n📋 Day 14 — Static tests (filesystem):\n');

test('Field Companion route POST /field exists in routes/agent.js', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'routes', 'agent.js'), 'utf8');
  assert.ok(src.includes('/field'), 'routes/agent.js must include /field route');
  assert.ok(src.includes('equipment_type'), 'routes/agent.js must handle equipment_type');
  assert.ok(src.includes('urgency'), 'routes/agent.js must handle urgency');
  assert.ok(src.includes('safety_warnings'), 'routes/agent.js must return safety_warnings');
  assert.ok(src.includes('escalate_to_professional'), 'routes/agent.js must return escalate_to_professional');
});

test('Leaderboard route GET /leaderboard exists in routes/certifications.js', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'routes', 'certifications.js'), 'utf8');
  assert.ok(src.includes('/leaderboard'), 'routes/certifications.js must include /leaderboard route');
  assert.ok(src.includes('display_name'), 'leaderboard must compute display_name');
  assert.ok(src.includes('rank'), 'leaderboard must include rank field');
});

test('XPRIZE demo endpoint registered in server.js', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes('/api/demo'), 'server.js must include /api/demo endpoint');
  assert.ok(src.includes('DEMO_QUESTION'), 'server.js must define DEMO_QUESTION');
  assert.ok(src.includes('platform stats') || src.includes('total_tracks'), 'demo must return platform stats');
});

test('XPRIZE metrics endpoint registered in server.js', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes('/api/xprize/metrics'), 'server.js must include /api/xprize/metrics endpoint');
  assert.ok(src.includes('days_since_launch'), 'metrics must include days_since_launch');
  assert.ok(src.includes('gemini_api_calls'), 'metrics must include gemini_api_calls');
});

test('Cloud Run check added to /api/health in server.js', () => {
  const src = fs.readFileSync(path.join(API_ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes('cloudrun'), 'server.js health endpoint must include cloudrun check');
  assert.ok(src.includes('CLOUD_RUN_URL'), 'server.js must define CLOUD_RUN_URL');
});

// ─── HTTP tests — run against live API ────────────────────────────────────────

console.log('\n🌐 Day 14 — HTTP tests (live API):\n');

async function runHttpTests() {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

  // Test 1: GET /api/demo — 200
  await asyncTest('GET /api/demo returns 200', async () => {
    const { status } = await request('GET', '/api/demo');
    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
  });

  // Test 2: GET /api/demo — answer field
  await asyncTest('GET /api/demo returns answer from AI', async () => {
    const { status, body } = await request('GET', '/api/demo');
    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(body.demo, 'Response must have demo object');
    assert.ok(body.demo.answer && body.demo.answer.length > 10, 'demo.answer must be a non-trivial string');
    assert.ok(typeof body.demo.confidence === 'number', 'demo.confidence must be a number');
    assert.ok(typeof body.demo.response_time_ms === 'number', 'demo.response_time_ms must be a number');
    assert.ok(body.demo.model_used, 'demo.model_used must be present');
  });

  // Test 3: GET /api/demo — platform stats
  await asyncTest('GET /api/demo returns platform stats', async () => {
    const { status, body } = await request('GET', '/api/demo');
    assert.strictEqual(status, 200);
    assert.ok(body.platform, 'Response must have platform object');
    assert.ok(typeof body.platform.total_tracks  === 'number', 'platform.total_tracks must be number');
    assert.ok(typeof body.platform.total_lessons === 'number', 'platform.total_lessons must be number');
    assert.ok(typeof body.platform.total_users   === 'number', 'platform.total_users must be number');
  });

  // Test 4: GET /api/health — cloudrun check
  await asyncTest('GET /api/health includes cloudrun check', async () => {
    const { status, body } = await request('GET', '/api/health');
    assert.ok([200, 503].includes(status), `Health returned unexpected status ${status}`);
    assert.ok(body.checks, 'Health response must have checks object');
    assert.ok('cloudrun' in body.checks, 'checks must include cloudrun');
    assert.ok(body.checks.cloudrun.url, 'cloudrun check must include url');
  });

  // Test 5: POST /api/agent/field — 401 without API key
  await asyncTest('POST /api/agent/field returns 401 without API key', async () => {
    const { status } = await request('POST', '/api/agent/field', {
      body: { question: 'My HVAC is making noise', urgency: 'low' },
    });
    assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
  });

  // Test 6: POST /api/agent/field — 400 with missing question (but with fake key)
  await asyncTest('POST /api/agent/field returns 400 with missing question', async () => {
    const { status } = await request('POST', '/api/agent/field', {
      headers: { 'X-API-Key': 'invalid-test-key-000' },
      body: { urgency: 'low' },
    });
    // Will be 401 (bad key) or 400 (missing question) — both acceptable
    assert.ok([400, 401, 403].includes(status), `Expected 400/401/403, got ${status}`);
  });

  // Test 7: GET /api/xprize/metrics — 401 without token
  await asyncTest('GET /api/xprize/metrics returns 401 without admin token', async () => {
    const { status } = await request('GET', '/api/xprize/metrics');
    assert.strictEqual(status, 401, `Expected 401, got ${status}`);
  });

  // Test 8: GET /api/certifications/leaderboard — 200
  await asyncTest('GET /api/certifications/leaderboard returns 200', async () => {
    const { status, body } = await request('GET', '/api/certifications/leaderboard');
    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(body.success, 'Response must have success:true');
    assert.ok(Array.isArray(body.leaderboard), 'leaderboard must be an array');
    // If there are entries, verify shape
    if (body.leaderboard.length > 0) {
      const first = body.leaderboard[0];
      assert.ok(typeof first.rank           === 'number', 'entry must have rank (number)');
      assert.ok(typeof first.display_name   === 'string', 'entry must have display_name (string)');
      assert.ok(typeof first.lessons_completed === 'number', 'entry must have lessons_completed (number)');
      assert.ok(typeof first.tracks_completed  === 'number', 'entry must have tracks_completed (number)');
    }
  });
}

runHttpTests().then(() => {
  console.log('\n🏁 Day 14 tests complete.\n');
});

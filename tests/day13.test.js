'use strict';

/**
 * tests/day13.test.js
 *
 * Day 13 verification tests — Certification & Learning Platform
 *
 *  1. GET  /api/certifications/tracks — 200, correct shape
 *  2. GET  /api/certifications/tracks — returns array of tracks
 *  3. GET  /api/certifications/tracks/:id/lessons — 401 without auth
 *  4. GET  /api/certifications/lessons/:id — 401 without auth
 *  5. POST /api/certifications/lessons/:id/complete — 401 without auth
 *  6. GET  /api/certifications/progress — 401 without auth
 *  7. POST /api/certifications/lessons/:id/quiz — 401 without auth
 *  8. POST /api/certifications/lessons/:id/quiz — 400 for missing/invalid answers
 *  9. POST /api/certifications/tracks/:id/certificate — 401 without auth
 * 10. Certifications route file exists
 * 11. Migration SQL file exists and contains required tables
 * 12. Certifications route is registered in server.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');

const API_ROOT = path.join(__dirname, '..');

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

function httpRequest(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3001,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Run tests ────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n🔧 Day 13 Tests — Certification & Learning Platform\n');

  // ── Static file checks ──────────────────────────────────────────────────────

  test('Certifications route file exists', () => {
    const routePath = path.join(API_ROOT, 'routes', 'certifications.js');
    assert.ok(fs.existsSync(routePath), `File not found: ${routePath}`);
  });

  test('Migration SQL file exists', () => {
    const migrationPath = path.join(
      API_ROOT,
      'supabase',
      'migrations',
      '20260608_certifications.sql'
    );
    assert.ok(fs.existsSync(migrationPath), `Migration not found: ${migrationPath}`);
  });

  test('Migration SQL contains user_progress table', () => {
    const migrationPath = path.join(
      API_ROOT,
      'supabase',
      'migrations',
      '20260608_certifications.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.ok(sql.includes('user_progress'), 'user_progress table missing from migration');
  });

  test('Migration SQL contains certificates table', () => {
    const migrationPath = path.join(
      API_ROOT,
      'supabase',
      'migrations',
      '20260608_certifications.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.ok(sql.includes('certificates'), 'certificates table missing from migration');
  });

  test('Migration SQL contains seed data for 4 tracks', () => {
    const migrationPath = path.join(
      API_ROOT,
      'supabase',
      'migrations',
      '20260608_certifications.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.ok(sql.includes("'electrical'"), 'electrical track missing');
    assert.ok(sql.includes("'hvac'"), 'hvac track missing');
    assert.ok(sql.includes("'plumbing'"), 'plumbing track missing');
    assert.ok(sql.includes("'general'"), 'general track missing');
  });

  test('Certifications route is registered in server.js', () => {
    const serverPath = path.join(API_ROOT, 'server.js');
    const src = fs.readFileSync(serverPath, 'utf8');
    assert.ok(
      src.includes('/api/certifications') && src.includes('certifications'),
      '/api/certifications not registered in server.js'
    );
  });

  // ── Live API tests ──────────────────────────────────────────────────────────

  await testAsync('GET /api/certifications/tracks → 200 OK', async () => {
    const { status, body } = await httpRequest('GET', '/api/certifications/tracks');
    assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  });

  await testAsync('GET /api/certifications/tracks → returns success:true', async () => {
    const { status, body } = await httpRequest('GET', '/api/certifications/tracks');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true, `Expected success:true, got: ${JSON.stringify(body)}`);
  });

  await testAsync('GET /api/certifications/tracks → has tracks array', async () => {
    const { status, body } = await httpRequest('GET', '/api/certifications/tracks');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.tracks), `tracks should be an array, got: ${typeof body.tracks}`);
  });

  await testAsync('GET /api/certifications/tracks/:id/lessons → 401 without auth', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await httpRequest('GET', `/api/certifications/tracks/${fakeId}/lessons`);
    assert.strictEqual(status, 401, `Expected 401 without auth, got ${status}`);
  });

  await testAsync('GET /api/certifications/lessons/:id → 401 without auth', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await httpRequest('GET', `/api/certifications/lessons/${fakeId}`);
    assert.strictEqual(status, 401, `Expected 401 without auth, got ${status}`);
  });

  await testAsync('POST /api/certifications/lessons/:id/complete → 401 without auth', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await httpRequest('POST', `/api/certifications/lessons/${fakeId}/complete`, {});
    assert.strictEqual(status, 401, `Expected 401 without auth, got ${status}`);
  });

  await testAsync('GET /api/certifications/progress → 401 without auth', async () => {
    const { status } = await httpRequest('GET', '/api/certifications/progress');
    assert.strictEqual(status, 401, `Expected 401 without auth, got ${status}`);
  });

  await testAsync('POST /api/certifications/lessons/:id/quiz → 401 without auth', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await httpRequest(
      'POST',
      `/api/certifications/lessons/${fakeId}/quiz`,
      { answers: [{ questionId: 'q1', answer: 'A' }] }
    );
    assert.strictEqual(status, 401, `Expected 401 without auth, got ${status}`);
  });

  await testAsync('POST /api/certifications/tracks/:id/certificate → 401 without auth', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await httpRequest(
      'POST',
      `/api/certifications/tracks/${fakeId}/certificate`,
      {}
    );
    assert.strictEqual(status, 401, `Expected 401 without auth, got ${status}`);
  });

  console.log('\n🏁 Day 13 tests complete.\n');
})();

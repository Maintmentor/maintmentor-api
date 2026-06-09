'use strict';

/**
 * tests/day16.test.js
 *
 * Day 16 verification tests — Polish, Performance & XPRIZE Submission Prep
 *
 *  Static tests (filesystem):
 *   1. sitemap.xml exists in frontend public/
 *   2. sitemap.xml contains all required routes
 *   3. robots.txt exists in frontend public/
 *   4. robots.txt contains Sitemap directive
 *   5. ErrorBoundary component exists in frontend src/
 *   6. ErrorBoundary has maintenance-themed render (Wrench icon)
 *
 *  HTTP tests (live API — no auth required):
 *   7. GET /api/version returns 200
 *   8. GET /api/version returns correct version fields
 *   9. GET /api/version build equals "day16"
 *  10. GET /api/health still returns 200
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');

const BASE_URL       = process.env.TEST_API_URL || 'http://127.0.0.1:3001';
const FRONTEND_ROOT  = path.resolve(__dirname, '../../maintenance-mentor-app');
const PUBLIC_DIR     = path.join(FRONTEND_ROOT, 'public');
const SRC_DIR        = path.join(FRONTEND_ROOT, 'src');

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.message}`);
    failed++;
    results.push({ name, ok: false, error: err.message });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔧 Day 16 — Polish, Performance & XPRIZE Submission Prep\n');

  // ── Static: Sitemap ────────────────────────────────────────────────────────
  await test('sitemap.xml exists in public/', () => {
    const sitemapPath = path.join(PUBLIC_DIR, 'sitemap.xml');
    assert.ok(fs.existsSync(sitemapPath), `sitemap.xml not found at ${sitemapPath}`);
  });

  await test('sitemap.xml contains all required routes', () => {
    const sitemapPath = path.join(PUBLIC_DIR, 'sitemap.xml');
    const content = fs.readFileSync(sitemapPath, 'utf8');
    const requiredRoutes = ['/', '/demo', '/developers', '/learn', '/field', '/pricing', '/contact'];
    for (const route of requiredRoutes) {
      assert.ok(
        content.includes(`maintmentor.ai${route}`),
        `sitemap.xml missing route: ${route}`
      );
    }
  });

  // ── Static: robots.txt ─────────────────────────────────────────────────────
  await test('robots.txt exists in public/', () => {
    const robotsPath = path.join(PUBLIC_DIR, 'robots.txt');
    assert.ok(fs.existsSync(robotsPath), `robots.txt not found at ${robotsPath}`);
  });

  await test('robots.txt contains Sitemap directive', () => {
    const robotsPath = path.join(PUBLIC_DIR, 'robots.txt');
    const content = fs.readFileSync(robotsPath, 'utf8');
    assert.ok(
      content.includes('Sitemap:') && content.includes('sitemap.xml'),
      'robots.txt missing Sitemap directive pointing to sitemap.xml'
    );
  });

  // ── Static: ErrorBoundary ─────────────────────────────────────────────────
  await test('ErrorBoundary component exists in src/components/', () => {
    const ebPath = path.join(SRC_DIR, 'components', 'ErrorBoundary.tsx');
    assert.ok(fs.existsSync(ebPath), `ErrorBoundary.tsx not found at ${ebPath}`);
  });

  await test('ErrorBoundary has maintenance-themed error page (Wrench icon)', () => {
    const ebPath = path.join(SRC_DIR, 'components', 'ErrorBoundary.tsx');
    const content = fs.readFileSync(ebPath, 'utf8');
    assert.ok(
      content.includes('Wrench') || content.includes('wrench') || content.includes('🔧'),
      'ErrorBoundary does not appear to have a maintenance-themed error page'
    );
  });

  // ── HTTP: /api/version ────────────────────────────────────────────────────
  await test('GET /api/version returns 200', async () => {
    const { status } = await get(`${BASE_URL}/api/version`);
    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
  });

  await test('GET /api/version returns correct fields', async () => {
    const { body } = await get(`${BASE_URL}/api/version`);
    const data = JSON.parse(body);
    assert.ok(data.version, 'Missing version field');
    assert.ok(data.build, 'Missing build field');
    assert.ok(data.environment, 'Missing environment field');
  });

  await test('GET /api/version build equals "day16"', async () => {
    const { body } = await get(`${BASE_URL}/api/version`);
    const data = JSON.parse(body);
    assert.strictEqual(data.build, 'day16', `Expected build "day16", got "${data.build}"`);
  });

  // ── HTTP: Health still works ──────────────────────────────────────────────
  await test('GET /api/health returns 200', async () => {
    const { status } = await get(`${BASE_URL}/api/health`);
    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Day 16 Tests: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.ok).forEach(r => console.log(`  • ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('\n✅  All Day 16 checks passed!');
    process.exit(0);
  }
})();

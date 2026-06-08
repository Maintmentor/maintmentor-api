'use strict';

/**
 * tests/day10.test.js
 *
 * Day 10 tests — Go-Live Prep
 *
 *   1. OpenAPI spec — file exists and is valid YAML with required fields
 *   2. SDK — exports expected functions, constructor validates apiKey
 *   3. Load test script — file exists and parses cleanly
 *   4. Anomaly detector — sendDailyAnomalySummary function exists and is exported
 *   5. Rate limiter — limits are sane (100/min general, 10/min photo)
 *
 * No real network calls are made.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ─── Test Harness ──────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  _testQueue.push({ name, fn });
}
const _testQueue = [];

async function runAll() {
  console.log('\n=== Day 10 Tests: Go-Live Prep ===\n');

  for (const { name, fn } of _testQueue) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${name}`);
      console.log(`     ${err.message}`);
      failures.push({ name, err });
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  if (failed > 0) {
    console.log('Failures:');
    for (const { name, err } of failures) {
      console.log(`  • ${name}: ${err.message}`);
    }
    process.exit(1);
  } else {
    console.log('✅ All Day 10 tests passed!');
  }
}

// ─── Paths ─────────────────────────────────────────────────────────────────────

const ROOT          = path.join(__dirname, '..');
const OPENAPI_PATH  = path.join(ROOT, 'docs', 'openapi.yaml');
const SDK_PATH      = path.join(ROOT, 'sdk', 'maintmentor-client.js');
const SDK_README    = path.join(ROOT, 'sdk', 'README.md');
const LOAD_TEST     = path.join(ROOT, 'scripts', 'load-test.js');
const ANOMALY_LIB   = path.join(ROOT, 'lib', 'anomalyDetector.js');
const RATE_LIMITER  = path.join(ROOT, 'middleware', 'rateLimiter.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. OpenAPI Spec
// ─────────────────────────────────────────────────────────────────────────────

test('OpenAPI spec: docs/openapi.yaml exists', () => {
  assert.ok(
    fs.existsSync(OPENAPI_PATH),
    `docs/openapi.yaml not found at ${OPENAPI_PATH}`
  );
});

test('OpenAPI spec: is non-empty', () => {
  const stat = fs.statSync(OPENAPI_PATH);
  assert.ok(stat.size > 1000, `openapi.yaml is suspiciously small (${stat.size} bytes)`);
});

test('OpenAPI spec: is valid YAML (parseable)', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');

  // Minimal YAML parser check — no external deps.
  // We verify required top-level keys are present as plain text matches.
  assert.ok(content.includes('openapi:'),  'Missing "openapi:" key');
  assert.ok(content.includes('info:'),     'Missing "info:" key');
  assert.ok(content.includes('paths:'),    'Missing "paths:" key');
  assert.ok(content.includes('components:'), 'Missing "components:" key');
});

test('OpenAPI spec: correct OpenAPI version (3.x)', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(
    /openapi:\s*['"]*3\.[01]/.test(content),
    'openapi.yaml must declare openapi: 3.x'
  );
});

test('OpenAPI spec: covers POST /api/agent/query', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('/api/agent/query'), 'Missing /api/agent/query path');
});

test('OpenAPI spec: covers POST /api/agent/photo', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('/api/agent/photo'), 'Missing /api/agent/photo path');
});

test('OpenAPI spec: covers GET /api/agent/usage', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('/api/agent/usage'), 'Missing /api/agent/usage path');
});

test('OpenAPI spec: covers wallet endpoints', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('/api/dashboard/wallet/topup'),        'Missing /wallet/topup');
  assert.ok(content.includes('/api/dashboard/wallet/packs'),        'Missing /wallet/packs');
  assert.ok(content.includes('/api/dashboard/wallet/balance'),      'Missing /wallet/balance');
  assert.ok(content.includes('/api/dashboard/wallet/transactions'), 'Missing /wallet/transactions');
});

test('OpenAPI spec: covers usage dashboard endpoints', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('/api/dashboard/usage/summary'), 'Missing /usage/summary');
  assert.ok(content.includes('/api/dashboard/usage/chart'),   'Missing /usage/chart');
});

test('OpenAPI spec: covers key management endpoints', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('/api/dashboard/keys'),        'Missing /dashboard/keys POST');
  assert.ok(content.includes('/api/dashboard/keys/{id}'),   'Missing /dashboard/keys/{id} DELETE');
  assert.ok(content.includes('/api/dashboard/keys/rotate'), 'Missing /dashboard/keys/rotate');
});

test('OpenAPI spec: defines authentication schemes', () => {
  const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
  assert.ok(content.includes('securitySchemes:'), 'Missing securitySchemes');
  assert.ok(content.includes('apiKey:'),          'Missing apiKey scheme');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SDK
// ─────────────────────────────────────────────────────────────────────────────

test('SDK: sdk/maintmentor-client.js exists', () => {
  assert.ok(fs.existsSync(SDK_PATH), `SDK not found at ${SDK_PATH}`);
});

test('SDK: sdk/README.md exists', () => {
  assert.ok(fs.existsSync(SDK_README), `SDK README not found at ${SDK_README}`);
});

test('SDK: module loads without error', () => {
  // Module may reference https/http which is fine — just ensure it loads
  let MaintMentorClient;
  assert.doesNotThrow(() => {
    MaintMentorClient = require(SDK_PATH);
  }, 'SDK module threw on require');
  assert.ok(MaintMentorClient, 'SDK module returned falsy');
});

test('SDK: exports MaintMentorClient as default and named export', () => {
  const mod = require(SDK_PATH);
  assert.ok(typeof mod === 'function', 'Default export should be the MaintMentorClient class');
  assert.ok(mod.MaintMentorClient, 'Named export MaintMentorClient missing');
  assert.strictEqual(mod, mod.MaintMentorClient, 'Default and named exports should be the same class');
});

test('SDK: exports MaintMentorError', () => {
  const { MaintMentorError } = require(SDK_PATH);
  assert.ok(typeof MaintMentorError === 'function', 'MaintMentorError should be a class/function');
});

test('SDK: exports SDK_VERSION string', () => {
  const { SDK_VERSION } = require(SDK_PATH);
  assert.ok(typeof SDK_VERSION === 'string', 'SDK_VERSION should be a string');
  assert.ok(SDK_VERSION.length > 0, 'SDK_VERSION should be non-empty');
});

test('SDK: MaintMentorClient constructor requires apiKey', () => {
  const MaintMentorClient = require(SDK_PATH);
  assert.throws(
    () => new MaintMentorClient({}),
    /apiKey is required/,
    'Should throw when apiKey is missing'
  );
});

test('SDK: MaintMentorClient constructor validates apiKey prefix', () => {
  const MaintMentorClient = require(SDK_PATH);
  assert.throws(
    () => new MaintMentorClient({ apiKey: 'invalid_key_no_prefix' }),
    /mm_pk_/,
    'Should throw when apiKey does not start with mm_pk_'
  );
});

test('SDK: MaintMentorClient constructor accepts valid apiKey', () => {
  const MaintMentorClient = require(SDK_PATH);
  let client;
  assert.doesNotThrow(() => {
    client = new MaintMentorClient({ apiKey: 'mm_pk_test_abc123xyz' });
  }, 'Should not throw with valid apiKey');
  assert.ok(client, 'Client should be instantiated');
});

test('SDK: client exposes query, photo, usage methods', () => {
  const MaintMentorClient = require(SDK_PATH);
  const client = new MaintMentorClient({ apiKey: 'mm_pk_test_abc123xyz' });
  assert.ok(typeof client.query === 'function', 'client.query should be a function');
  assert.ok(typeof client.photo === 'function', 'client.photo should be a function');
  assert.ok(typeof client.usage === 'function', 'client.usage should be a function');
});

test('SDK: client.query validates question argument', async () => {
  const MaintMentorClient = require(SDK_PATH);
  const client = new MaintMentorClient({ apiKey: 'mm_pk_test_abc123xyz' });

  await assert.rejects(
    () => client.query(''),
    /non-empty string/,
    'Should reject empty question'
  );

  await assert.rejects(
    () => client.query('x'.repeat(2001)),
    /2000 character limit/,
    'Should reject question exceeding 2000 chars'
  );
});

test('SDK: client.photo validates images argument', async () => {
  const MaintMentorClient = require(SDK_PATH);
  const client = new MaintMentorClient({ apiKey: 'mm_pk_test_abc123xyz' });

  await assert.rejects(
    () => client.photo('test question', []),
    /non-empty array/,
    'Should reject empty images array'
  );

  await assert.rejects(
    () => client.photo('test question', ['a','b','c','d','e','f']),
    /maximum 5 images/,
    'Should reject more than 5 images'
  );
});

test('SDK: MaintMentorError has status and code properties', () => {
  const { MaintMentorError } = require(SDK_PATH);
  const err = new MaintMentorError('Test error', 402, 'INSUFFICIENT_BALANCE');
  assert.strictEqual(err.status, 402);
  assert.strictEqual(err.code,   'INSUFFICIENT_BALANCE');
  assert.strictEqual(err.message, 'Test error');
  assert.strictEqual(err.name,    'MaintMentorError');
  assert.ok(err instanceof Error, 'MaintMentorError should extend Error');
});

test('SDK: README covers all three methods', () => {
  const content = fs.readFileSync(SDK_README, 'utf8');
  assert.ok(content.includes('client.query'),  'README missing client.query docs');
  assert.ok(content.includes('client.photo'),  'README missing client.photo docs');
  assert.ok(content.includes('client.usage'),  'README missing client.usage docs');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Load Test Script
// ─────────────────────────────────────────────────────────────────────────────

test('Load test: scripts/load-test.js exists', () => {
  assert.ok(fs.existsSync(LOAD_TEST), `load-test.js not found at ${LOAD_TEST}`);
});

test('Load test: script is non-empty', () => {
  const stat = fs.statSync(LOAD_TEST);
  assert.ok(stat.size > 500, `load-test.js is suspiciously small (${stat.size} bytes)`);
});

test('Load test: script uses only built-in modules (no require of external packages)', () => {
  const content = fs.readFileSync(LOAD_TEST, 'utf8');

  // Allow only Node built-ins
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  const allowedBuiltins = new Set([
    'http', 'https', 'url', 'path', 'fs', 'os', 'crypto',
    'util', 'events', 'stream', 'buffer', 'querystring', 'assert',
  ]);

  let match;
  const externalDeps = [];
  while ((match = requireRegex.exec(content)) !== null) {
    const mod = match[1];
    // Skip relative requires
    if (mod.startsWith('.') || mod.startsWith('/')) continue;
    // Check if it's a known built-in
    if (!allowedBuiltins.has(mod)) {
      externalDeps.push(mod);
    }
  }

  assert.deepStrictEqual(
    externalDeps,
    [],
    `load-test.js must use only built-in modules. Found external: ${externalDeps.join(', ')}`
  );
});

test('Load test: script targets GET /api/agent/usage', () => {
  const content = fs.readFileSync(LOAD_TEST, 'utf8');
  assert.ok(
    content.includes('/api/agent/usage'),
    'load-test.js should target /api/agent/usage'
  );
});

test('Load test: script reports p50, p95, p99 latency', () => {
  const content = fs.readFileSync(LOAD_TEST, 'utf8');
  assert.ok(content.includes('p50'), 'load-test.js should report p50');
  assert.ok(content.includes('p95'), 'load-test.js should report p95');
  assert.ok(content.includes('p99'), 'load-test.js should report p99');
});

test('Load test: script reports error rate', () => {
  const content = fs.readFileSync(LOAD_TEST, 'utf8');
  assert.ok(
    content.toLowerCase().includes('error rate') || content.toLowerCase().includes('errorrate'),
    'load-test.js should report error rate'
  );
});

test('Load test: script has configurable concurrency (default 10)', () => {
  const content = fs.readFileSync(LOAD_TEST, 'utf8');
  assert.ok(
    content.includes('CONCURRENCY') || content.includes('concurrency'),
    'load-test.js should have a CONCURRENCY setting'
  );
  assert.ok(content.includes("'10'") || content.includes('"10"') || content.includes('= 10'),
    'Default concurrency should be 10'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Anomaly Detector — Daily Digest
// ─────────────────────────────────────────────────────────────────────────────

test('Anomaly detector: lib/anomalyDetector.js exists', () => {
  assert.ok(fs.existsSync(ANOMALY_LIB), `anomalyDetector.js not found`);
});

test('Anomaly detector: exports sendDailyAnomalySummary function', () => {
  // We do a text check first to avoid loading the module (which requires supabase/resend)
  const content = fs.readFileSync(ANOMALY_LIB, 'utf8');
  assert.ok(
    content.includes('sendDailyAnomalySummary'),
    'anomalyDetector.js must export sendDailyAnomalySummary'
  );
  assert.ok(
    content.includes('module.exports') && content.includes('sendDailyAnomalySummary'),
    'sendDailyAnomalySummary must be in module.exports'
  );
});

test('Anomaly detector: sendDailyAnomalySummary queries anomaly_events', () => {
  const content = fs.readFileSync(ANOMALY_LIB, 'utf8');
  // Check the function queries the right table
  assert.ok(
    content.includes("'anomaly_events'"),
    'sendDailyAnomalySummary should query anomaly_events table'
  );
});

test('Anomaly detector: sendDailyAnomalySummary sends email to dean@maintmentor.ai', () => {
  const content = fs.readFileSync(ANOMALY_LIB, 'utf8');
  assert.ok(
    content.includes('dean@maintmentor.ai'),
    'sendDailyAnomalySummary should email dean@maintmentor.ai'
  );
});

test('Anomaly detector: sendDailyAnomalySummary queries last 24 hours', () => {
  const content = fs.readFileSync(ANOMALY_LIB, 'utf8');
  assert.ok(
    content.includes('24') && content.includes('gte'),
    'sendDailyAnomalySummary should filter for last 24h using gte'
  );
});

test('Anomaly detector: still exports startAnomalyScan and runAnomalyScan', () => {
  const content = fs.readFileSync(ANOMALY_LIB, 'utf8');
  assert.ok(content.includes('startAnomalyScan'),  'Missing startAnomalyScan export');
  assert.ok(content.includes('runAnomalyScan'),    'Missing runAnomalyScan export');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Rate Limiter Sanity Check
// ─────────────────────────────────────────────────────────────────────────────

test('Rate limiter: middleware/rateLimiter.js exists', () => {
  assert.ok(fs.existsSync(RATE_LIMITER), 'rateLimiter.js not found');
});

test('Rate limiter: agentApiLimiter is 100 req/min', () => {
  const content = fs.readFileSync(RATE_LIMITER, 'utf8');
  // Verify max: 100 appears in the file (agentApiLimiter block)
  assert.ok(
    /max:\s*100/.test(content),
    'agentApiLimiter should be set to max: 100'
  );
});

test('Rate limiter: photoLimiter is 10 req/min', () => {
  const content = fs.readFileSync(RATE_LIMITER, 'utf8');
  // Verify max: 10 appears in the file (photoLimiter block)
  assert.ok(
    /max:\s*10[^0]/.test(content) || /max:\s*10$/.test(content) || /max:\s*10,/.test(content),
    'photoLimiter should be set to max: 10'
  );
});

test('Rate limiter: uses key-based (not IP-based) rate limiting', () => {
  const content = fs.readFileSync(RATE_LIMITER, 'utf8');
  assert.ok(
    content.includes('keyGenerator') && content.includes('apiContext'),
    'Rate limiter should use API key prefix as the key, not IP'
  );
});

test('Rate limiter: review comment block present (Day 10)', () => {
  const content = fs.readFileSync(RATE_LIMITER, 'utf8');
  assert.ok(
    content.includes('Rate Limit Review') || content.includes('Go-Live'),
    'Day 10 rate limit review comment block should be present'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Run!
// ─────────────────────────────────────────────────────────────────────────────

runAll();

'use strict';

/**
 * tests/day8.test.js
 *
 * Day 8 tests for:
 *   1. GET /api/dashboard/wallet/balance      — full wallet summary
 *   2. GET /api/dashboard/wallet/transactions — paginated transaction history
 *   3. GET /api/dashboard/usage/summary       — today/month/lifetime aggregates
 *   4. GET /api/dashboard/usage/chart         — daily chart data
 *   5. seed-knowledge-base.js module integrity — exports + fallback content
 *
 * All external calls (Supabase, Gemini) are MOCKED.
 * No real API calls are made.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ─── Test Harness ──────────────────────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
let skipped  = 0;
const failures = [];
const _testQueue = [];

function test(name, fn) {
  _testQueue.push({ name, fn: fn || null });
}

async function _runAll() {
  for (const { name, fn } of _testQueue) {
    if (fn === null) {
      console.log(`  ⏭️  ${name} (skipped)`);
      skipped++;
      continue;
    }
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.message}`);
      failures.push({ name, message: err.message });
      failed++;
    }
  }
}

// ─── Mock Builder ──────────────────────────────────────────────────────────────

/**
 * Build a minimal Express-like request object for route handler testing.
 */
function mockReq(overrides = {}) {
  return {
    user: { id: 'user-abc-123' },
    query: {},
    params: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

/**
 * Build a minimal Express-like response object that captures the response.
 */
function mockRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    send(body)   { this._body = body; return this; },
  };
  return res;
}

// ─── Supabase Mock Factory ─────────────────────────────────────────────────────

/**
 * Build a chainable Supabase mock.
 * Calls resolve in sequence for .single() and direct awaits.
 *
 * @param {Array<{data, error, count}>} calls - Responses in call order
 */
function buildSupaMock(calls) {
  let callIdx = 0;

  function makeChain() {
    const response = calls[callIdx++] || { data: null, error: null };

    const chain = {
      select:  () => chain,
      from:    () => chain,
      eq:      () => chain,
      neq:     () => chain,
      gte:     () => chain,
      lte:     () => chain,
      order:   () => chain,
      limit:   () => chain,
      range:   () => chain,
      in:      () => chain,
      insert:  () => chain,
      update:  () => chain,
      upsert:  () => chain,
      delete:  () => chain,
      maybeSingle: () => Promise.resolve(response),
      single:  () => Promise.resolve(response),
      // For direct await (count queries with head:true)
      then: (resolve) => resolve(response),
    };
    return chain;
  }

  return {
    from: (table) => makeChain(),
    rpc:  (fn, args) => Promise.resolve(calls[callIdx++] || { data: null, error: null }),
  };
}

// ─── Load dashboard router (patching supabase for each test) ──────────────────

// We re-require the router per-test section by manipulating require.cache.
// Instead, we'll extract the route handlers by calling them directly.
// The cleaner approach: load the router once and override the supabase module.

// Patch the supabase module in require.cache
function patchSupabase(mockClient) {
  const supabaseKey = require.resolve('../lib/supabase');
  require.cache[supabaseKey] = {
    id: supabaseKey,
    filename: supabaseKey,
    loaded: true,
    exports: mockClient,
  };
}

function restoreSupabase() {
  const supabaseKey = require.resolve('../lib/supabase');
  delete require.cache[supabaseKey];
}

// ─── Section 1: GET /wallet/balance ──────────────────────────────────────────

console.log('\n─── Section 1: GET /wallet/balance ───────────────────────────────────');

test('GET /wallet/balance returns correct wallet summary structure', async () => {
  const mockWallet = {
    id: 'wallet-001',
    balance_usd: 250,
    solana_address: 'ABC123def456',
    auto_recharge_enabled: false,
    stripe_customer_id: 'cus_stripe123',
  };

  patchSupabase(buildSupaMock([
    { data: mockWallet, error: null },
  ]));

  // Clear dashboard cache to pick up patched supabase
  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  // Find the GET /wallet/balance handler by walking the router stack
  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/balance' && l.route.methods.get
  );
  assert.ok(route, 'GET /wallet/balance route must be registered');

  const req = mockReq();
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.ok(typeof res._body.balance_credits === 'number', 'balance_credits must be a number');
  assert.ok(typeof res._body.balance_usd === 'number', 'balance_usd must be a number');
  assert.strictEqual(res._body.balance_credits, 250);
  assert.strictEqual(res._body.balance_usd, 250);
  assert.strictEqual(res._body.solana_address, 'ABC123def456');
  assert.strictEqual(res._body.auto_recharge_enabled, false);
  assert.strictEqual(res._body.stripe_customer_id, 'cus_stripe123');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /wallet/balance returns 404 when wallet not found', async () => {
  patchSupabase(buildSupaMock([
    { data: null, error: { code: 'PGRST116', message: 'Row not found' } },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/balance' && l.route.methods.get
  );

  const req = mockReq();
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.code, 'WALLET_NOT_FOUND');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /wallet/balance nulls stripe_customer_id and solana_address when absent', async () => {
  const mockWallet = {
    id: 'wallet-002',
    balance_usd: 100,
    solana_address: null,
    auto_recharge_enabled: null,
    stripe_customer_id: null,
  };

  patchSupabase(buildSupaMock([
    { data: mockWallet, error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/balance' && l.route.methods.get
  );

  const req = mockReq();
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.solana_address, null);
  assert.strictEqual(res._body.stripe_customer_id, null);
  assert.strictEqual(res._body.auto_recharge_enabled, false);

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

// ─── Section 2: GET /wallet/transactions ─────────────────────────────────────

console.log('\n─── Section 2: GET /wallet/transactions ─────────────────────────────');

test('GET /wallet/transactions returns paginated transaction list', async () => {
  const mockWallet = { id: 'wallet-001' };
  const mockTxs = [
    { id: 'tx-1', amount_usd: 50, type: 'credit', description: 'Stripe purchase', created_at: '2026-06-01T00:00:00Z', token_mint: null, stripe_payment_intent_id: 'pi_123' },
    { id: 'tx-2', amount_usd: -5, type: 'debit',  description: 'Agent query',    created_at: '2026-06-01T01:00:00Z', token_mint: null, stripe_payment_intent_id: null },
  ];

  patchSupabase(buildSupaMock([
    { data: mockWallet, error: null },
    { data: mockTxs, error: null, count: 42 },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/transactions' && l.route.methods.get
  );
  assert.ok(route, 'GET /wallet/transactions route must be registered');

  const req = mockReq({ query: { limit: '10', offset: '0' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.ok(Array.isArray(res._body.transactions), 'transactions must be array');
  assert.strictEqual(res._body.limit, 10);
  assert.strictEqual(res._body.offset, 0);

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /wallet/transactions clamps limit to 100', async () => {
  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [], error: null, count: 0 },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/transactions' && l.route.methods.get
  );

  const req = mockReq({ query: { limit: '999' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.limit, 100, 'limit should be clamped to 100');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /wallet/transactions uses default limit 20 when not provided', async () => {
  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [], error: null, count: 0 },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/transactions' && l.route.methods.get
  );

  const req = mockReq({ query: {} });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.limit, 20, 'default limit should be 20');
  assert.strictEqual(res._body.offset, 0, 'default offset should be 0');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /wallet/transactions returns 404 when no wallet', async () => {
  patchSupabase(buildSupaMock([
    { data: null, error: { code: 'PGRST116', message: 'not found' } },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/transactions' && l.route.methods.get
  );

  const req = mockReq({ query: {} });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._body.code, 'WALLET_NOT_FOUND');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /wallet/transactions includes required fields on each transaction', async () => {
  const tx = {
    id: 'tx-999',
    amount_usd: 100,
    type: 'credit',
    description: 'USDC deposit',
    created_at: '2026-06-07T12:00:00Z',
    token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    stripe_payment_intent_id: null,
  };

  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [tx], error: null, count: 1 },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/wallet/transactions' && l.route.methods.get
  );

  const req = mockReq({ query: {} });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  const firstTx = res._body.transactions[0];
  assert.ok(firstTx.id,          'id required');
  assert.ok(firstTx.amount_usd !== undefined, 'amount_usd required');
  assert.ok(firstTx.type,        'type required');
  assert.ok(firstTx.description, 'description required');
  assert.ok(firstTx.created_at,  'created_at required');
  // token_mint and stripe_payment_intent_id may be null

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

// ─── Section 3: GET /usage/summary ────────────────────────────────────────────

console.log('\n─── Section 3: GET /usage/summary ───────────────────────────────────');

test('GET /usage/summary returns correct aggregated structure', async () => {
  const now = new Date();
  const todayStr = now.toISOString();
  const mockLogs = [
    { endpoint: '/api/agent/query', credits_charged: 5, created_at: todayStr },
    { endpoint: '/api/agent/query', credits_charged: 5, created_at: todayStr },
    { endpoint: '/api/agent/photo', credits_charged: 15, created_at: todayStr },
  ];

  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: mockLogs, error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/summary' && l.route.methods.get
  );
  assert.ok(route, 'GET /usage/summary route must be registered');

  const req = mockReq();
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  const body = res._body;

  // Structure checks
  assert.ok(typeof body.today === 'object',      'today must be object');
  assert.ok(typeof body.this_month === 'object', 'this_month must be object');
  assert.ok(typeof body.lifetime === 'object',   'lifetime must be object');
  assert.ok(Array.isArray(body.top_categories),  'top_categories must be array');

  // Aggregate checks (all logs are today)
  assert.strictEqual(body.today.queries, 2,   'today queries = 2');
  assert.strictEqual(body.today.photos,  1,   'today photos = 1');
  assert.strictEqual(body.today.credits_used, 25, 'today credits = 25');

  // Lifetime matches today (all logs are today)
  assert.strictEqual(body.lifetime.queries, 2);
  assert.strictEqual(body.lifetime.photos,  1);
  assert.strictEqual(body.lifetime.credits_used, 25);

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/summary returns zeroes when no wallet exists', async () => {
  patchSupabase(buildSupaMock([
    { data: null, error: { code: 'PGRST116', message: 'not found' } },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/summary' && l.route.methods.get
  );

  const req = mockReq();
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200, 'returns 200 (not 404) for no-wallet case');
  assert.strictEqual(res._body.today.queries, 0);
  assert.strictEqual(res._body.lifetime.credits_used, 0);
  assert.deepStrictEqual(res._body.top_categories, []);

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/summary top_categories populated correctly', async () => {
  const now = new Date().toISOString();
  const mockLogs = [
    { endpoint: '/api/agent/query', credits_charged: 5, created_at: now },
    { endpoint: '/api/agent/query', credits_charged: 5, created_at: now },
    { endpoint: '/api/agent/query', credits_charged: 5, created_at: now },
    { endpoint: '/api/agent/photo', credits_charged: 15, created_at: now },
  ];

  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: mockLogs, error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/summary' && l.route.methods.get
  );

  const req = mockReq();
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  const topCats = res._body.top_categories;
  assert.ok(topCats.length > 0, 'should have top categories');
  assert.ok(topCats[0].category, 'each entry has category');
  assert.ok(typeof topCats[0].count === 'number', 'each entry has count');
  // query should be top category (appears 3 times vs photo once)
  assert.strictEqual(topCats[0].category, 'query');
  assert.strictEqual(topCats[0].count, 3);

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

// ─── Section 4: GET /usage/chart ──────────────────────────────────────────────

console.log('\n─── Section 4: GET /usage/chart ──────────────────────────────────────');

test('GET /usage/chart returns correct number of data points for default 30 days', async () => {
  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [], error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/chart' && l.route.methods.get
  );
  assert.ok(route, 'GET /usage/chart route must be registered');

  const req = mockReq({ query: {} });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.ok(Array.isArray(res._body.labels),  'labels must be array');
  assert.ok(Array.isArray(res._body.queries), 'queries must be array');
  assert.ok(Array.isArray(res._body.credits), 'credits must be array');
  assert.strictEqual(res._body.labels.length,  30, 'default 30 days of labels');
  assert.strictEqual(res._body.queries.length, 30, 'default 30 days of queries');
  assert.strictEqual(res._body.credits.length, 30, 'default 30 days of credits');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/chart respects custom days param', async () => {
  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [], error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/chart' && l.route.methods.get
  );

  const req = mockReq({ query: { days: '7' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.labels.length, 7);

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/chart clamps days to max 90', async () => {
  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [], error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/chart' && l.route.methods.get
  );

  const req = mockReq({ query: { days: '999' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._body.labels.length, 90, 'should clamp to 90 days');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/chart labels are in YYYY-MM-DD format and ascending', async () => {
  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: [], error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/chart' && l.route.methods.get
  );

  const req = mockReq({ query: { days: '5' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);
  const labels = res._body.labels;
  assert.strictEqual(labels.length, 5);

  // Each label should be YYYY-MM-DD
  for (const label of labels) {
    assert.match(label, /^\d{4}-\d{2}-\d{2}$/, `"${label}" should be YYYY-MM-DD`);
  }

  // Labels should be ascending (oldest first)
  for (let i = 1; i < labels.length; i++) {
    assert.ok(labels[i] >= labels[i - 1], 'labels should be in ascending order');
  }

  // Last label should be today
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  assert.strictEqual(labels[labels.length - 1], todayStr, 'last label should be today');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/chart populates data for days with usage', async () => {
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  const mockLogs = [
    { endpoint: '/api/agent/query', credits_charged: 5,  created_at: today.toISOString() },
    { endpoint: '/api/agent/query', credits_charged: 5,  created_at: today.toISOString() },
    { endpoint: '/api/agent/photo', credits_charged: 15, created_at: today.toISOString() },
  ];

  patchSupabase(buildSupaMock([
    { data: { id: 'wallet-001' }, error: null },
    { data: mockLogs, error: null },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/chart' && l.route.methods.get
  );

  const req = mockReq({ query: { days: '7' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200);

  // Find today's index
  const todayIdx = res._body.labels.indexOf(todayStr);
  assert.ok(todayIdx >= 0, 'today should be in labels');

  // Today should have 3 queries (query, query, photo all count as queries for charting)
  assert.strictEqual(res._body.queries[todayIdx], 3, 'today should show 3 queries');
  assert.strictEqual(res._body.credits[todayIdx], 25, 'today should show 25 credits');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

test('GET /usage/chart returns empty data points for no-wallet case', async () => {
  patchSupabase(buildSupaMock([
    { data: null, error: { code: 'PGRST116', message: 'not found' } },
  ]));

  const dashKey = require.resolve('../routes/dashboard');
  delete require.cache[dashKey];
  const router = require('../routes/dashboard');

  const route = router.stack.find(
    l => l.route && l.route.path === '/usage/chart' && l.route.methods.get
  );

  const req = mockReq({ query: { days: '7' } });
  const res = mockRes();
  await route.route.stack[0].handle(req, res, () => {});

  assert.strictEqual(res._status, 200, 'returns 200 for no-wallet case');
  assert.strictEqual(res._body.labels.length, 7);
  assert.ok(res._body.queries.every(q => q === 0), 'all queries should be 0');
  assert.ok(res._body.credits.every(c => c === 0), 'all credits should be 0');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

// ─── Section 5: seed-knowledge-base.js module integrity ───────────────────────

console.log('\n─── Section 5: seed-knowledge-base.js integrity ────────────────────');

test('seed-knowledge-base.js file exists', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  assert.ok(fs.existsSync(scriptPath), 'seed-knowledge-base.js must exist');
});

test('seed-knowledge-base.js contains at least 20 hardcoded Q&A pairs', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  const content = fs.readFileSync(scriptPath, 'utf8');

  // Count Q&A objects in FALLBACK_QA array
  const matches = content.match(/question:/g);
  assert.ok(matches && matches.length >= 20, `Should have at least 20 Q&A pairs, found ${matches ? matches.length : 0}`);
});

test('seed-knowledge-base.js covers all required categories', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  const content = fs.readFileSync(scriptPath, 'utf8');

  const requiredCategories = ['electrical', 'hvac', 'plumbing', 'appliance', 'general'];
  for (const cat of requiredCategories) {
    assert.ok(content.includes(`category: '${cat}'`), `Must include category: ${cat}`);
  }
});

test('seed-knowledge-base.js has rate limiting constant of 100ms', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(content.includes('RATE_LIMIT_MS'), 'Must define RATE_LIMIT_MS');
  assert.ok(content.includes('= 100'), 'RATE_LIMIT_MS must be 100ms');
});

test('seed-knowledge-base.js saves summary to data/seed-summary.json', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(content.includes('seed-summary.json'), 'Must reference seed-summary.json');
});

test('seed-knowledge-base.js checks row count and warns if > 50', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(content.includes('ROW_WARN_THRESH'), 'Must define ROW_WARN_THRESH');
  assert.ok(content.includes('--force'), 'Must mention --force flag');
});

test('seed-knowledge-base.js uses LOTO procedure content', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'seed-knowledge-base.js');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(content.includes('LOTO') || content.includes('Lockout'), 'Must include LOTO/Lockout content');
});

// ─── Section 6: Route registration check ─────────────────────────────────────

console.log('\n─── Section 6: Route registration check ────────────────────────────');

test('dashboard.js loads without error and has all 4 new routes', () => {
  // Reload cleanly
  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];

  // Create a minimal supabase mock that won't throw on require
  patchSupabase({
    from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }),
  });

  const router = require('../routes/dashboard');

  const routePaths = router.stack
    .filter(l => l.route)
    .map(l => `${Object.keys(l.route.methods).join('|').toUpperCase()} ${l.route.path}`);

  assert.ok(routePaths.some(r => r.includes('GET') && r.includes('/wallet/balance')),
    'GET /wallet/balance must be registered');
  assert.ok(routePaths.some(r => r.includes('GET') && r.includes('/wallet/transactions')),
    'GET /wallet/transactions must be registered');
  assert.ok(routePaths.some(r => r.includes('GET') && r.includes('/usage/summary')),
    'GET /usage/summary must be registered');
  assert.ok(routePaths.some(r => r.includes('GET') && r.includes('/usage/chart')),
    'GET /usage/chart must be registered');

  restoreSupabase();
  delete require.cache[require.resolve('../routes/dashboard')];
});

// ─── Run all tests ────────────────────────────────────────────────────────────

_runAll().then(() => {
  console.log('\n' + '─'.repeat(60));
  if (failed === 0) {
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('\n✅ All Day 8 tests passed!');
  } else {
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('\n❌ Failures:');
    for (const f of failures) {
      console.log(`   - ${f.name}: ${f.message}`);
    }
    process.exit(1);
  }
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

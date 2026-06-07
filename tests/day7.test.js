'use strict';

/**
 * tests/day7.test.js
 *
 * Day 7 tests for:
 *   1. USDC token transfer detection and crediting (processSolanaDeposit)
 *   2. SOL transfer regression (existing path still works after refactor)
 *   3. Unknown token transfers ignored gracefully
 *   4. USDC idempotency — duplicate signature skipped
 *   5. POST /api/dashboard/wallet/link-solana — address validation + save
 *   6. GET /api/dashboard/wallet/solana-address — returns linked address
 *   7. Migration file exists with correct columns
 *   8. webhooks.js module exports USDC_MINT constant
 *
 * All external calls (Supabase, CoinGecko, Resend) are MOCKED.
 * No real API calls are made.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ─── Test Harness ──────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
let skipped = 0;
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

function eq(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function ok(v, msg) {
  if (!v) throw new Error(msg || 'Expected truthy value');
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const USDC_MINT          = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAINTMENTOR_WALLET = 'MaintMentorWallet1111111111111111111111111111';

// ─── Module Loader Interceptor ─────────────────────────────────────────────────

const Module = require('module');
const originalLoad = Module._load.bind(Module);

Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.includes('maintmentor-api')) {
    if (request === '../lib/stripe' || request.endsWith('lib/stripe')) {
      return {
        stripe: { webhooks: { constructEvent: () => { throw new Error('stripe not needed'); } } },
        getActiveCreditPacks: async () => [],
        getCreditPackById: async () => null,
      };
    }
    if (request === 'resend') {
      return {
        Resend: class {
          emails = { send: async () => ({ id: 'email-mock-id' }) };
        },
      };
    }
  }
  return originalLoad(request, parent, isMain);
};

// ─── Mock Factories ────────────────────────────────────────────────────────────

function makeSupabaseMock({
  existingTransactions = [], // array of external_ids already in DB
  userWallet = null,         // returned for wallets.solana_address lookup
  creditError = null,        // simulate credit_wallet RPC error
} = {}) {
  const insertedRows = [];
  const rpcCalls = [];

  return {
    insertedRows,
    rpcCalls,
    from: (table) => ({
      select: (_cols) => ({
        eq: (col, val) => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          maybeSingle: async () => {
            if (table === 'wallet_transactions' && col === 'external_id') {
              const found = existingTransactions.includes(val);
              return { data: found ? { id: 'existing-tx' } : null, error: null };
            }
            if (table === 'wallets' && col === 'solana_address') {
              return { data: userWallet, error: null };
            }
            if (table === 'profiles') {
              return { data: { email: 'user@example.com', full_name: 'Test User' }, error: null };
            }
            return { data: null, error: null };
          },
          single: async () => ({ data: null, error: null }),
        }),
      }),
      insert: (row) => ({
        then: (cb) => { insertedRows.push(row); return Promise.resolve(cb({ error: null })); },
        select: () => ({ single: async () => ({ data: { id: 'new-row' }, error: null }) }),
      }),
      update: () => ({
        eq: () => ({ eq: async () => ({ error: null }) }),
      }),
    }),
    rpc: async (name, params) => {
      rpcCalls.push({ name, params });
      if (creditError) return { error: creditError };
      // simulate getOrCreateWallet RPC returning a wallet object
      return { data: { id: 'w-1', balance_usd: 100, solana_address: null }, error: null };
    },
  };
}

// Load webhooks module with a given supabase mock (fresh require each time)
function loadWebhooks(supabaseMock) {
  const key     = require.resolve('../routes/webhooks');
  const supaKey = require.resolve('../lib/supabase');
  const origCache = require.cache[supaKey];
  delete require.cache[key];
  require.cache[supaKey] = { id: supaKey, filename: supaKey, loaded: true, exports: supabaseMock };
  const mod = require('../routes/webhooks');
  if (origCache) require.cache[supaKey] = origCache; else delete require.cache[supaKey];
  return mod;
}

// Make a dashboard-compatible supabase mock
function makeDashboardMock({ wallet = null, solanaAddress = null, updateError = null } = {}) {
  const updates = [];
  const baseWallet = wallet || { id: 'w-1', balance_usd: 100, solana_address: solanaAddress };
  return {
    updates,
    from: (table) => ({
      select: (_cols) => ({
        eq: (col, val) => ({
          maybeSingle: async () => {
            if (table === 'wallets') return { data: baseWallet, error: null };
            return { data: null, error: null };
          },
          single: async () => {
            if (table === 'wallets') return { data: baseWallet, error: null };
            return { data: null, error: null };
          },
        }),
      }),
      update: (data) => ({
        eq: (col, val) => {
          updates.push({ table, data, col, val });
          return { error: updateError || null };
        },
      }),
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: { id: 'key-1', key_prefix: 'mm_test', label: null, is_active: true, created_at: new Date().toISOString() },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async () => ({ data: baseWallet, error: null }),
  };
}

function loadDashboard(supabaseMock) {
  const key     = require.resolve('../routes/dashboard');
  const supaKey = require.resolve('../lib/supabase');
  const origCache = require.cache[supaKey];
  delete require.cache[key];
  require.cache[supaKey] = { id: supaKey, filename: supaKey, loaded: true, exports: supabaseMock };
  const mod = require('../routes/dashboard');
  if (origCache) require.cache[supaKey] = origCache; else delete require.cache[supaKey];
  return mod;
}

function mockJwtReq(overrides = {}) {
  return { user: { id: 'user-uuid-test' }, body: {}, params: {}, headers: {}, ...overrides };
}

function mockJwtRes() {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json   = (body) => { res._body = body; return res; };
  res.send   = () => res;
  return res;
}

function getRouteHandler(router, method, routePath) {
  const stack = router.stack || [];
  for (const layer of stack) {
    if (layer.route &&
        layer.route.path === routePath &&
        layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`No ${method.toUpperCase()} ${routePath} handler found in router`);
}

// ─── Section 1: USDC Transfer Detection + Crediting ───────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 1: USDC Transfer Detection + Crediting');
console.log('──────────────────────────────────────────────────────────');

test('USDC transfer in tokenTransfers → credit_wallet called with correct USD amount', async () => {
  const dbMock = makeSupabaseMock({
    userWallet: { id: 'wallet-1', user_id: 'user-1' },
  });
  const mod = loadWebhooks(dbMock);

  const tx = {
    signature: 'sig_usdc_001',
    nativeTransfers: [],
    tokenTransfers: [{
      fromUserAccount: 'UserSolAddr1111111111111111111111111111111111',
      toUserAccount:   MAINTMENTOR_WALLET,
      mint:            USDC_MINT,
      tokenAmount:     50.00,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  process.env.RESEND_API_KEY = '';
  await mod.processSolanaDeposit(tx);

  eq(dbMock.rpcCalls.length, 1, 'credit_wallet should be called once');
  eq(dbMock.rpcCalls[0].name, 'credit_wallet', 'RPC name should be credit_wallet');
  eq(dbMock.rpcCalls[0].params.p_credits, 50.00, 'USDC amount = USD value');
  ok(dbMock.rpcCalls[0].params.p_description.includes('USDC'), 'description should mention USDC');
  ok(dbMock.rpcCalls[0].params.p_stripe_payment_intent.startsWith('usdc:'), 'external_id should start with "usdc:"');
});

test('USDC external_id prefixed with "usdc:" contains tx signature', async () => {
  const dbMock = makeSupabaseMock({ userWallet: { id: 'w-2', user_id: 'u-2' } });
  const mod    = loadWebhooks(dbMock);

  const tx = {
    signature: 'sig_usdc_002',
    nativeTransfers: [],
    tokenTransfers: [{
      fromUserAccount: 'UserSolAddr2222222222222222222222222222222222',
      toUserAccount:   MAINTMENTOR_WALLET,
      mint:            USDC_MINT,
      tokenAmount:     100.50,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);

  const extId = dbMock.rpcCalls[0].params.p_stripe_payment_intent;
  ok(extId.startsWith('usdc:'), `external_id should start with "usdc:", got "${extId}"`);
  ok(extId.includes('sig_usdc_002'), 'external_id should contain tx signature');
});

test('USDC tokenAmount maps 1:1 to USD credits (1 USDC = $1.00)', async () => {
  const dbMock = makeSupabaseMock({ userWallet: { id: 'w-3', user_id: 'u-3' } });
  const mod    = loadWebhooks(dbMock);

  const tx = {
    signature: 'sig_usdc_003',
    nativeTransfers: [],
    tokenTransfers: [{
      fromUserAccount: 'UserSolAddr3333333333333333333333333333333333',
      toUserAccount:   MAINTMENTOR_WALLET,
      mint:            USDC_MINT,
      tokenAmount:     25.75,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);

  eq(dbMock.rpcCalls[0].params.p_credits, 25.75, 'credits should equal USDC amount exactly');
});

test('USDC deposit from unknown address → credit_pending row, no credit_wallet call', async () => {
  const dbMock = makeSupabaseMock({ userWallet: null }); // unknown sender
  const mod    = loadWebhooks(dbMock);

  const tx = {
    signature: 'sig_usdc_unknown',
    nativeTransfers: [],
    tokenTransfers: [{
      fromUserAccount: 'UnknownSolAddr111111111111111111111111111111',
      toUserAccount:   MAINTMENTOR_WALLET,
      mint:            USDC_MINT,
      tokenAmount:     10.00,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx); // should NOT throw

  eq(dbMock.rpcCalls.length, 0, 'credit_wallet should NOT be called for unknown sender');
  eq(dbMock.insertedRows.length, 1, 'should insert a credit_pending audit row');
  eq(dbMock.insertedRows[0].type, 'credit_pending', 'pending row type should be credit_pending');
  eq(dbMock.insertedRows[0].token_mint, USDC_MINT, 'token_mint should be USDC_MINT on pending row');
});

// ─── Section 2: SOL Transfer Regression ───────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 2: SOL Transfer Regression (existing flow)');
console.log('──────────────────────────────────────────────────────────');

test('SOL native transfer still credited correctly after USDC refactor', async () => {
  const dbMock = makeSupabaseMock({ userWallet: { id: 'w-sol-1', user_id: 'u-sol-1' } });
  const mod    = loadWebhooks(dbMock);

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, json: async () => ({ solana: { usd: 150 } }),
  });
  mod._resetSolPriceCache();

  const tx = {
    signature: 'sig_sol_001',
    nativeTransfers: [{
      fromUserAccount: 'SolUserAddr1111111111111111111111111111111111',
      toUserAccount:   MAINTMENTOR_WALLET,
      amount:          1_000_000_000, // 1 SOL in lamports
    }],
    tokenTransfers: [],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);
  global.fetch = originalFetch;

  eq(dbMock.rpcCalls.length, 1, 'credit_wallet called once');
  eq(dbMock.rpcCalls[0].params.p_credits, 150.00, '1 SOL * $150/SOL = $150 credits');
  ok(dbMock.rpcCalls[0].params.p_description.includes('SOL'), 'description mentions SOL');
  ok(dbMock.rpcCalls[0].params.p_stripe_payment_intent.startsWith('sol:'), 'SOL external_id prefixed "sol:"');
});

test('SOL external_id uses "sol:" prefix, not "usdc:"', async () => {
  const dbMock = makeSupabaseMock({ userWallet: { id: 'w-sol-2', user_id: 'u-sol-2' } });
  const mod    = loadWebhooks(dbMock);

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, json: async () => ({ solana: { usd: 200 } }),
  });
  mod._resetSolPriceCache();

  const tx = {
    signature: 'sig_sol_002',
    nativeTransfers: [{
      fromUserAccount: 'SolUserAddr2222222222222222222222222222222222',
      toUserAccount:   MAINTMENTOR_WALLET,
      amount:          500_000_000, // 0.5 SOL
    }],
    tokenTransfers: [],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);
  global.fetch = originalFetch;

  const extId = dbMock.rpcCalls[0].params.p_stripe_payment_intent;
  ok(extId.startsWith('sol:'), `SOL external_id should start with "sol:", got "${extId}"`);
});

// ─── Section 3: Unknown Token Transfers Ignored ────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 3: Unknown Token Transfers Ignored Gracefully');
console.log('──────────────────────────────────────────────────────────');

test('Non-USDC token transfer silently ignored (no credit, no crash)', async () => {
  const dbMock = makeSupabaseMock({ userWallet: { id: 'w-x', user_id: 'u-x' } });
  const mod    = loadWebhooks(dbMock);

  const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
  const tx = {
    signature: 'sig_unknown_token',
    nativeTransfers: [],
    tokenTransfers: [{
      fromUserAccount: 'UserSolAddrXXXX111111111111111111111111111111',
      toUserAccount:   MAINTMENTOR_WALLET,
      mint:            WRAPPED_SOL,
      tokenAmount:     999,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx); // must not throw

  eq(dbMock.rpcCalls.length, 0, 'credit_wallet should NOT be called for unknown token');
  eq(dbMock.insertedRows.length, 0, 'no row inserted for non-USDC unknown token');
});

test('Transaction with mixed tokens: only USDC credited, unknown ignored', async () => {
  const dbMock = makeSupabaseMock({ userWallet: { id: 'w-mixed', user_id: 'u-mixed' } });
  const mod    = loadWebhooks(dbMock);

  const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
  const tx = {
    signature: 'sig_mixed',
    nativeTransfers: [],
    tokenTransfers: [
      {
        fromUserAccount: 'UserSolAddrMIXED11111111111111111111111111111',
        toUserAccount:   MAINTMENTOR_WALLET,
        mint:            WRAPPED_SOL,
        tokenAmount:     500,
      },
      {
        fromUserAccount: 'UserSolAddrMIXED11111111111111111111111111111',
        toUserAccount:   MAINTMENTOR_WALLET,
        mint:            USDC_MINT,
        tokenAmount:     20.00,
      },
    ],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);

  eq(dbMock.rpcCalls.length, 1, 'exactly one credit_wallet call (for USDC only)');
  eq(dbMock.rpcCalls[0].params.p_credits, 20.00, 'only USDC amount credited');
});

test('Empty transaction (no transfers) skipped without error', async () => {
  const dbMock = makeSupabaseMock({ userWallet: null });
  const mod    = loadWebhooks(dbMock);

  const tx = { signature: 'sig_empty', nativeTransfers: [], tokenTransfers: [] };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);

  eq(dbMock.rpcCalls.length, 0, 'no RPC calls for empty tx');
  eq(dbMock.insertedRows.length, 0, 'no rows inserted for empty tx');
});

// ─── Section 4: USDC Idempotency ──────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 4: Idempotency (duplicate suppression)');
console.log('──────────────────────────────────────────────────────────');

test('Duplicate USDC external_id → credit_wallet NOT called again', async () => {
  const fromAddr = 'UserSolAddrDUPE1111111111111111111111111111111';
  const sig      = 'sig_usdc_dupe_001';
  const dbMock   = makeSupabaseMock({
    existingTransactions: [`usdc:${sig}:${fromAddr}`],
    userWallet: { id: 'w-dupe', user_id: 'u-dupe' },
  });
  const mod = loadWebhooks(dbMock);

  const tx = {
    signature: sig,
    nativeTransfers: [],
    tokenTransfers: [{
      fromUserAccount: fromAddr,
      toUserAccount:   MAINTMENTOR_WALLET,
      mint:            USDC_MINT,
      tokenAmount:     75.00,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);

  eq(dbMock.rpcCalls.length, 0, 'credit_wallet should NOT be called for duplicate USDC tx');
});

test('Duplicate SOL external_id → credit_wallet NOT called again (regression)', async () => {
  const fromAddr = 'UserSolAddrDUPE2222222222222222222222222222222';
  const sig      = 'sig_sol_dupe_001';
  const dbMock   = makeSupabaseMock({
    existingTransactions: [`sol:${sig}:${fromAddr}`],
    userWallet: { id: 'w-sol-dupe', user_id: 'u-sol-dupe' },
  });
  const mod = loadWebhooks(dbMock);

  const tx = {
    signature: sig,
    nativeTransfers: [{
      fromUserAccount: fromAddr,
      toUserAccount:   MAINTMENTOR_WALLET,
      amount:          2_000_000_000,
    }],
    tokenTransfers: [],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);

  eq(dbMock.rpcCalls.length, 0, 'credit_wallet should NOT be called for duplicate SOL tx');
});

test('SOL duplicate does not block USDC (independent idempotency keys)', async () => {
  const fromAddr = 'UserSolAddrCOMBO111111111111111111111111111111';
  const sig      = 'sig_combo_001';
  // Only SOL already processed
  const dbMock = makeSupabaseMock({
    existingTransactions: [`sol:${sig}:${fromAddr}`],
    userWallet: { id: 'w-combo', user_id: 'u-combo' },
  });
  const mod = loadWebhooks(dbMock);

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ solana: { usd: 100 } }) });
  mod._resetSolPriceCache();

  const tx = {
    signature: sig,
    nativeTransfers: [{
      fromUserAccount: fromAddr, toUserAccount: MAINTMENTOR_WALLET, amount: 1_000_000_000,
    }],
    tokenTransfers: [{
      fromUserAccount: fromAddr, toUserAccount: MAINTMENTOR_WALLET, mint: USDC_MINT, tokenAmount: 50.00,
    }],
  };

  process.env.MAINTMENTOR_SOLANA_WALLET = MAINTMENTOR_WALLET;
  await mod.processSolanaDeposit(tx);
  global.fetch = originalFetch;

  eq(dbMock.rpcCalls.length, 1, 'only USDC should be credited (SOL already processed)');
  ok(dbMock.rpcCalls[0].params.p_stripe_payment_intent.startsWith('usdc:'), 'credited tx is USDC');
});

// ─── Section 5: link-solana Endpoint ──────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 5: POST /api/dashboard/wallet/link-solana');
console.log('──────────────────────────────────────────────────────────');

test('link-solana accepts valid 44-char base58 Solana address', async () => {
  const dbMock = makeDashboardMock();
  const router = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  const req = mockJwtReq({ body: { solana_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 200, 'should return 200');
  eq(res._body.success, true, 'success should be true');
  eq(res._body.solana_address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'echoes back address');
});

test('link-solana rejects missing solana_address (400 MISSING_SOLANA_ADDRESS)', async () => {
  const dbMock  = makeDashboardMock();
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  const req = mockJwtReq({ body: {} });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 400, 'should return 400');
  eq(res._body.code, 'MISSING_SOLANA_ADDRESS', 'correct error code');
});

test('link-solana rejects address with "0" (invalid base58 char)', async () => {
  const dbMock  = makeDashboardMock();
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  // Leading "0" is not in base58 alphabet
  const req = mockJwtReq({ body: { solana_address: '0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 400, 'should return 400');
  eq(res._body.code, 'INVALID_SOLANA_ADDRESS', 'correct error code');
});

test('link-solana rejects address with "O" (invalid base58 char)', async () => {
  const dbMock  = makeDashboardMock();
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  const req = mockJwtReq({ body: { solana_address: 'OPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 400, 'should return 400 for "O" char');
  eq(res._body.code, 'INVALID_SOLANA_ADDRESS');
});

test('link-solana rejects address shorter than 32 chars', async () => {
  const dbMock  = makeDashboardMock();
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  const req = mockJwtReq({ body: { solana_address: 'shortAddress' } });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 400, 'should return 400 for too-short address');
  eq(res._body.code, 'INVALID_SOLANA_ADDRESS');
});

test('link-solana rejects address longer than 44 chars', async () => {
  const dbMock  = makeDashboardMock();
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  const req = mockJwtReq({ body: { solana_address: 'A'.repeat(45) } });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 400, 'should return 400 for too-long address');
  eq(res._body.code, 'INVALID_SOLANA_ADDRESS');
});

test('link-solana rejects non-string solana_address', async () => {
  const dbMock  = makeDashboardMock();
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'POST', '/wallet/link-solana');

  const req = mockJwtReq({ body: { solana_address: 12345 } });
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 400, 'should return 400 for numeric address');
  eq(res._body.code, 'INVALID_SOLANA_ADDRESS');
});

// ─── Section 6: GET /wallet/solana-address ────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 6: GET /api/dashboard/wallet/solana-address');
console.log('──────────────────────────────────────────────────────────');

test('GET solana-address returns linked address when set', async () => {
  const dbMock  = makeDashboardMock({ solanaAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'GET', '/wallet/solana-address');

  const req = mockJwtReq();
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 200, 'should return 200');
  eq(res._body.solana_address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'returns the linked address');
});

test('GET solana-address returns null when not set', async () => {
  const dbMock  = makeDashboardMock({ solanaAddress: null });
  const router  = loadDashboard(dbMock);
  const handler = getRouteHandler(router, 'GET', '/wallet/solana-address');

  const req = mockJwtReq();
  const res = mockJwtRes();
  await handler(req, res);

  eq(res._status, 200, 'should return 200');
  eq(res._body.solana_address, null, 'should return null when not linked');
});

// ─── Section 7: Migration File Validation ─────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 7: Migration File Validation');
console.log('──────────────────────────────────────────────────────────');

test('Migration file 20260607_solana.sql exists', async () => {
  const migPath = path.join(__dirname, '../supabase/migrations/20260607_solana.sql');
  ok(fs.existsSync(migPath), `Migration file should exist at ${migPath}`);
});

test('Migration adds solana_address to wallets table', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260607_solana.sql'), 'utf8');
  ok(sql.includes('solana_address'), 'SQL should reference solana_address');
  ok(sql.includes('wallets'), 'SQL should reference wallets table');
});

test('Migration adds token_mint to wallet_transactions table', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260607_solana.sql'), 'utf8');
  ok(sql.includes('token_mint'), 'SQL should reference token_mint');
  ok(sql.includes('wallet_transactions'), 'SQL should reference wallet_transactions');
});

test('Migration creates index on wallets.solana_address', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260607_solana.sql'), 'utf8');
  ok(sql.includes('CREATE INDEX'), 'SQL should create at least one index');
  // Index should be on solana_address
  const hasIdx = sql.includes('idx_wallets_solana_address') || sql.includes('solana_address');
  ok(hasIdx, 'Index should reference solana_address');
});

// ─── Section 8: Module Exports ────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log('Section 8: Module Exports + Constants');
console.log('──────────────────────────────────────────────────────────');

const freshWebhooks = loadWebhooks(makeSupabaseMock());

test('webhooks.js exports USDC_MINT constant with correct mainnet address', async () => {
  ok(typeof freshWebhooks.USDC_MINT === 'string', 'USDC_MINT should be a string');
  eq(freshWebhooks.USDC_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'should be mainnet USDC mint');
});

test('webhooks.js exports processSolanaDeposit function', async () => {
  ok(typeof freshWebhooks.processSolanaDeposit === 'function', 'processSolanaDeposit should be exported');
});

test('webhooks.js exports _resetSolPriceCache helper', async () => {
  ok(typeof freshWebhooks._resetSolPriceCache === 'function', '_resetSolPriceCache should be exported');
});

test('webhooks.js exports getSolUsdPrice function', async () => {
  ok(typeof freshWebhooks.getSolUsdPrice === 'function', 'getSolUsdPrice should be exported');
});

test('dashboard.js loads without error', async () => {
  const router = loadDashboard(makeDashboardMock());
  ok(router, 'dashboard module should load');
});

test('dashboard.js has POST /wallet/link-solana registered', async () => {
  const router = loadDashboard(makeDashboardMock());
  const stack  = router.stack || [];
  const found  = stack.some(l => l.route && l.route.path === '/wallet/link-solana' && l.route.methods.post);
  ok(found, 'POST /wallet/link-solana should be registered');
});

test('dashboard.js has GET /wallet/solana-address registered', async () => {
  const router = loadDashboard(makeDashboardMock());
  const stack  = router.stack || [];
  const found  = stack.some(l => l.route && l.route.path === '/wallet/solana-address' && l.route.methods.get);
  ok(found, 'GET /wallet/solana-address should be registered');
});

// ─── Run All Tests ─────────────────────────────────────────────────────────────

_runAll().then(() => {
  console.log(`\n${'─'.repeat(60)}`);
  if (failed === 0) {
    console.log(`Results: ${passed} passed, 0 failed, ${skipped} skipped\n`);
    console.log('✅ All Day 7 tests passed!');
  } else {
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  • ${f.name}: ${f.message}`));
    process.exit(1);
  }
});

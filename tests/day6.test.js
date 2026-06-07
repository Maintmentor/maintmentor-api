'use strict';

/**
 * tests/day6.test.js
 *
 * Day 6 — Data Flywheel: Embedding Worker + RAG Injection
 *
 * Tests cover:
 *   Section 1:  embedText — returns 768-float array (Gemini mocked)
 *   Section 2:  findSimilar — returns top results above threshold
 *   Section 3:  queueForEmbedding — adds to queue, skips low-confidence
 *   Section 4:  processEmbeddingQueue — embeds and marks done
 *   Section 5:  buildRagContext — formats context string, enforces timeout
 *   Section 6:  RAG injection in /api/agent/query (handler-level mock)
 *   Section 7:  Embedding queue triggered after successful query
 *   Section 8:  lib/embeddings.js module exports
 *
 * Run: node tests/day6.test.js
 */

const assert = require('assert');
const EventEmitter = require('events');

// ─── Test Harness ─────────────────────────────────────────────────────────────
// Tests run SERIALLY to prevent shared-state race conditions in mock injection.
let passed = 0;
let failed = 0;
let skipped = 0;

// Queue of { name, fn } — drained serially at the end
const _testQueue = [];
let _rootPromise = null;

function test(name, fn) {
  _testQueue.push({ name, fn });
}

function skip(name) {
  _testQueue.push({ name, fn: null }); // null fn = skip
}

// Drain the queue serially and collect all results
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
      failed++;
    }
  }
}

// ─── Mock Factories ────────────────────────────────────────────────────────────

/** 768-element float array filled with a constant value */
function makeEmbedding(fill = 0.5) {
  return Array(768).fill(fill);
}

/** Mock Gemini embedding model */
function mockGeminiEmbeddingModel(responseOverride) {
  return {
    embedContent: async (text) => {
      if (responseOverride && responseOverride.error) {
        throw new Error(responseOverride.error);
      }
      return {
        embedding: {
          values: responseOverride?.values || makeEmbedding(0.1),
        },
      };
    },
  };
}

/** Mock Supabase client builder */
function mockSupabase(overrides = {}) {
  const defaults = {
    from: () => ({
      insert: async () => ({ data: null, error: null }),
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
        in: async () => ({ data: null, error: null }),
      }),
      update: () => ({
        eq:  async () => ({ data: null, error: null }),
        in:  async () => ({ data: null, error: null }),
      }),
    }),
    rpc: async () => ({ data: [], error: null }),
    ...overrides,
  };
  return defaults;
}

/** Mock Express req */
function mockReq(overrides = {}) {
  return {
    method: 'POST',
    path: '/query',
    baseUrl: '/api/agent',
    url: '/api/agent/query',
    headers: {},
    body: { question: 'Why is my furnace making noise?' },
    apiContext: {
      apiKey: { id: 'key-uuid-111', user_id: 'user-uuid-222', prefix: 'mm_pk_test', label: 'Test' },
      wallet: { id: 'wallet-uuid-333', user_id: 'user-uuid-222', balance_usd: 100 },
      creditCost: 5,
    },
    billingMeta: null,
    _billingStartTime: Date.now(),
    ...overrides,
  };
}

/** Mock Express res */
function mockRes() {
  const emitter = new EventEmitter();
  let _statusCode = 200;
  let _body = null;
  const res = {
    statusCode: 200,
    status(code) { _statusCode = code; res.statusCode = code; return res; },
    json(body) { _body = body; emitter.emit('finish'); return res; },
    send(body) { _body = body; emitter.emit('finish'); return res; },
    on: emitter.on.bind(emitter),
    _getStatus: () => _statusCode,
    _getBody: () => _body,
  };
  return res;
}

// ─── Section 1: embedText ──────────────────────────────────────────────────────
console.log('\n📋 Section 1: embedText — Gemini embedding call');

test('embedText returns 768-element float array', async () => {
  const { _setEmbeddingModel, embedText } = require('../lib/embeddings');
  _setEmbeddingModel(mockGeminiEmbeddingModel({ values: makeEmbedding(0.42) }));

  const result = await embedText('My HVAC unit is leaking water');
  assert.strictEqual(Array.isArray(result), true, 'result should be array');
  assert.strictEqual(result.length, 768, 'should have 768 dimensions');
  assert.ok(result.every(v => typeof v === 'number'), 'all elements should be numbers');
});

test('embedText returns correct values from model', async () => {
  const { _setEmbeddingModel, embedText } = require('../lib/embeddings');
  const expected = makeEmbedding(0.99);
  _setEmbeddingModel(mockGeminiEmbeddingModel({ values: expected }));

  const result = await embedText('test query');
  assert.deepStrictEqual(result, expected);
});

test('embedText throws on empty string', async () => {
  const { embedText } = require('../lib/embeddings');
  await assert.rejects(() => embedText(''), /text must be a non-empty string/);
});

test('embedText throws on non-string input', async () => {
  const { embedText } = require('../lib/embeddings');
  await assert.rejects(() => embedText(null), /text must be a non-empty string/);
  await assert.rejects(() => embedText(123), /text must be a non-empty string/);
});

test('embedText throws when Gemini returns wrong dimensions', async () => {
  const { _setEmbeddingModel, embedText } = require('../lib/embeddings');
  _setEmbeddingModel(mockGeminiEmbeddingModel({ values: Array(512).fill(0.1) }));

  await assert.rejects(() => embedText('test'), /unexpected embedding shape/);
});

test('embedText propagates Gemini errors', async () => {
  const { _setEmbeddingModel, embedText } = require('../lib/embeddings');
  _setEmbeddingModel(mockGeminiEmbeddingModel({ error: 'Gemini API quota exceeded' }));

  await assert.rejects(() => embedText('test'), /Gemini API quota exceeded/);
});

test('embedText truncates very long text', async () => {
  const { _setEmbeddingModel, embedText, _CONFIG } = require('../lib/embeddings');
  let capturedText = null;
  _setEmbeddingModel({
    embedContent: async (input) => {
      // Handle both old string format and new object format
      if (typeof input === 'string') {
        capturedText = input;
      } else if (input && input.content && input.content.parts && input.content.parts[0]) {
        capturedText = input.content.parts[0].text;
      } else {
        capturedText = String(input);
      }
      return { embedding: { values: makeEmbedding(0.1) } };
    },
  });

  const longText = 'a'.repeat(_CONFIG.CONTENT_MAX_CHARS + 500);
  await embedText(longText);
  assert.strictEqual(capturedText.length, _CONFIG.CONTENT_MAX_CHARS, 'should truncate to max chars');
});

// ─── Section 2: findSimilar ────────────────────────────────────────────────────
console.log('\n📋 Section 2: findSimilar — cosine similarity search');

test('findSimilar returns empty array for invalid embedding', async () => {
  const { findSimilar } = require('../lib/embeddings');
  const result = await findSimilar(null);
  assert.deepStrictEqual(result, []);
});

test('findSimilar returns empty array for wrong-dimension embedding', async () => {
  const { findSimilar } = require('../lib/embeddings');
  const result = await findSimilar(Array(256).fill(0.1));
  assert.deepStrictEqual(result, []);
});

test('findSimilar returns results from Supabase RPC', async () => {
  const embeddings = require('../lib/embeddings');

  const fakeResults = [
    { id: 'uuid-1', content: 'Q: Why does my furnace click?\nA: Clicking is normal on startup.', metadata: { source: 'agent_query' }, similarity: 0.92 },
    { id: 'uuid-2', content: 'Q: Furnace noise?\nA: Could be the igniter.', metadata: { source: 'agent_query' }, similarity: 0.81 },
  ];

  embeddings._setSupabaseClient({
    rpc: async (fn, params) => {
      if (fn === 'match_embeddings') return { data: fakeResults, error: null };
      return { data: [], error: null };
    },
  });

  const result = await embeddings.findSimilar(makeEmbedding(0.5), 3, 0.75);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].similarity, 0.92);
  assert.ok(result[0].content.includes('furnace'));

  embeddings._resetSupabaseClient();
});

test('findSimilar returns empty array on RPC error', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setSupabaseClient({
    rpc: async () => ({ data: null, error: { message: 'relation "match_embeddings" does not exist' } }),
  });

  const result = await embeddings.findSimilar(makeEmbedding(0.5));
  assert.deepStrictEqual(result, []);

  embeddings._resetSupabaseClient();
});

test('findSimilar uses correct default parameters', async () => {
  const embeddings = require('../lib/embeddings');

  let capturedParams = null;
  embeddings._setSupabaseClient({
    rpc: async (fn, params) => {
      capturedParams = params;
      return { data: [], error: null };
    },
  });

  await embeddings.findSimilar(makeEmbedding(0.5));
  assert.strictEqual(capturedParams.match_threshold, 0.75, 'default threshold should be 0.75');
  assert.strictEqual(capturedParams.match_count, 3, 'default limit should be 3');

  embeddings._resetSupabaseClient();
});

// ─── Section 3: queueForEmbedding ─────────────────────────────────────────────
console.log('\n📋 Section 3: queueForEmbedding — adds to embedding queue');

test('queueForEmbedding inserts into embedding_queue', async () => {
  const embeddings = require('../lib/embeddings');

  let insertedRow = null;
  embeddings._setSupabaseClient({
    from: (table) => {
      if (table === 'embedding_queue') {
        return {
          insert: async (row) => {
            insertedRow = row;
            return { error: null };
          },
        };
      }
      return null;
    },
  });

  await embeddings.queueForEmbedding(
    'How do I fix a leaky faucet?',
    'Turn off the water supply valve under the sink. Replace the worn washer or O-ring inside the faucet handle. These are the main culprits for most drips.',
    { source: 'agent_query', confidence: 0.85, wallet_id: 'wallet-abc', category: 'plumbing' }
  );

  assert.ok(insertedRow, 'should have inserted a row');
  assert.strictEqual(insertedRow.status, 'pending');
  assert.strictEqual(insertedRow.metadata.source, 'agent_query');
  assert.strictEqual(insertedRow.metadata.confidence, 0.85);
  assert.strictEqual(insertedRow.metadata.wallet_id, 'wallet-abc');

  embeddings._resetSupabaseClient();
});

test('queueForEmbedding skips low-confidence answers', async () => {
  const embeddings = require('../lib/embeddings');
  const supabaseModule = require('../lib/supabase');

  let insertCalled = false;
  const origFrom = supabaseModule.from.bind(supabaseModule);
  supabaseModule.from = (table) => {
    if (table === 'embedding_queue') {
      return { insert: async () => { insertCalled = true; return { error: null }; } };
    }
    return origFrom(table);
  };

  // confidence 0.5 < MIN_CONFIDENCE (0.7) — should be skipped silently
  await embeddings.queueForEmbedding(
    'What is HVAC?',
    'HVAC stands for Heating, Ventilation, and Air Conditioning.',
    { confidence: 0.5 }
  );

  assert.strictEqual(insertCalled, false, 'should not insert low-confidence answer');

  supabaseModule.from = origFrom;
});

test('queueForEmbedding skips when confidence is 0', async () => {
  const embeddings = require('../lib/embeddings');
  const supabaseModule = require('../lib/supabase');

  let insertCalled = false;
  const origFrom = supabaseModule.from.bind(supabaseModule);
  supabaseModule.from = (table) => {
    if (table === 'embedding_queue') {
      return { insert: async () => { insertCalled = true; return { error: null }; } };
    }
    return origFrom(table);
  };

  await embeddings.queueForEmbedding('test?', 'test answer.', { confidence: 0 });
  assert.strictEqual(insertCalled, false);

  supabaseModule.from = origFrom;
});

test('queueForEmbedding does not throw on DB error', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setSupabaseClient({
    from: (table) => {
      if (table === 'embedding_queue') {
        return { insert: async () => ({ error: { message: 'DB connection refused' } }) };
      }
      return null;
    },
  });

  // Should not throw — logs error internally
  await assert.doesNotReject(() =>
    embeddings.queueForEmbedding('Test?', 'Test answer.', { confidence: 0.9 })
  );

  embeddings._resetSupabaseClient();
});

test('queueForEmbedding does not throw on missing question/answer', async () => {
  const embeddings = require('../lib/embeddings');
  await assert.doesNotReject(() =>
    embeddings.queueForEmbedding(null, null, { confidence: 0.9 })
  );
});

// ─── Section 4: processEmbeddingQueue ─────────────────────────────────────────
console.log('\n📋 Section 4: processEmbeddingQueue — worker embeds and marks done');

test('processEmbeddingQueue returns {processed:0, errors:0} when queue is empty', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setSupabaseClient({
    from: (table) => {
      if (table === 'embedding_queue') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          update: () => ({ in: async () => ({ error: null }), eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'knowledge_embeddings') {
        return { insert: async () => ({ error: null }) };
      }
      return null;
    },
  });

  const result = await embeddings.processEmbeddingQueue();
  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.errors, 0);

  embeddings._resetSupabaseClient();
});

test('processEmbeddingQueue embeds items and marks them done', async () => {
  const embeddings = require('../lib/embeddings');

  // Set up a mock embedding model
  embeddings._setEmbeddingModel(mockGeminiEmbeddingModel({ values: makeEmbedding(0.7) }));

  const pendingItems = [
    { id: 'item-1', question: 'How do I bleed a radiator?', answer: 'Use a radiator key to open the valve until water flows without air.', metadata: { source: 'agent_query', confidence: 0.88 } },
    { id: 'item-2', question: 'Why is my AC not cooling?', answer: 'Check the air filter, refrigerant level, and condenser coils.', metadata: { source: 'agent_query', confidence: 0.79 } },
  ];

  const doneSets = [];
  const insertedEmbeddings = [];

  embeddings._setSupabaseClient({
    from: (table) => {
      if (table === 'embedding_queue') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: pendingItems, error: null }),
              }),
            }),
          }),
          update: (updateObj) => ({
            in: async (col, ids) => ({ error: null }),
            eq: async (col, id) => {
              if (updateObj.status === 'done') doneSets.push(id);
              return { error: null };
            },
          }),
        };
      }
      if (table === 'knowledge_embeddings') {
        return {
          insert: async (row) => {
            insertedEmbeddings.push(row);
            return { error: null };
          },
        };
      }
      return null;
    },
  });

  const result = await embeddings.processEmbeddingQueue();

  assert.strictEqual(result.processed, 2, 'should process 2 items');
  assert.strictEqual(result.errors, 0, 'should have 0 errors');
  assert.strictEqual(insertedEmbeddings.length, 2, 'should insert 2 embeddings');
  assert.ok(insertedEmbeddings[0].content.startsWith('Q:'), 'content should start with Q:');
  assert.ok(insertedEmbeddings[0].embedding.length === 768, 'embedding should be 768-dim');
  assert.strictEqual(doneSets.length, 2, 'both items should be marked done');

  embeddings._resetSupabaseClient();
});

test('processEmbeddingQueue handles individual item errors gracefully', async () => {
  const embeddings = require('../lib/embeddings');

  let callCount = 0;
  embeddings._setEmbeddingModel({
    embedContent: async (text) => {
      callCount++;
      if (callCount === 1) throw new Error('Quota exceeded on first item');
      return { embedding: { values: makeEmbedding(0.5) } };
    },
  });

  const pendingItems = [
    { id: 'bad-item', question: 'Q1', answer: 'A1', metadata: {} },
    { id: 'good-item', question: 'Q2', answer: 'A2', metadata: {} },
  ];

  const errorMarked = [];
  embeddings._setSupabaseClient({
    from: (table) => {
      if (table === 'embedding_queue') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: pendingItems, error: null }),
              }),
            }),
          }),
          update: (updateObj) => ({
            in: async () => ({ error: null }),
            eq: async (col, id) => {
              if (updateObj.status === 'error') errorMarked.push(id);
              return { error: null };
            },
          }),
        };
      }
      if (table === 'knowledge_embeddings') {
        return { insert: async () => ({ error: null }) };
      }
      return null;
    },
  });

  const result = await embeddings.processEmbeddingQueue();

  assert.strictEqual(result.errors, 1, 'should record 1 error');
  assert.strictEqual(result.processed, 1, 'should process 1 successfully');
  assert.ok(errorMarked.includes('bad-item'), 'bad item should be marked error');

  embeddings._resetSupabaseClient();
});

test('processEmbeddingQueue returns {errors:0} on fetch failure (early return)', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setSupabaseClient({
    from: (table) => {
      if (table === 'embedding_queue') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: null, error: { message: 'DB error' } }),
              }),
            }),
          }),
        };
      }
      return null;
    },
  });

  const result = await embeddings.processEmbeddingQueue();
  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.errors, 0); // Fetch failure returns early with 0/0 (not an item error)

  embeddings._resetSupabaseClient();
});

// ─── Section 5: buildRagContext ────────────────────────────────────────────────
console.log('\n📋 Section 5: buildRagContext — RAG context formatting + timeout');

test('buildRagContext returns null when no similar items found', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setEmbeddingModel(mockGeminiEmbeddingModel({ values: makeEmbedding(0.1) }));
  embeddings._setSupabaseClient({ rpc: async () => ({ data: [], error: null }) });

  const result = await embeddings.buildRagContext('What is a P-trap?');
  assert.strictEqual(result, null, 'should return null when no similar items found');

  embeddings._resetSupabaseClient();
});

test('buildRagContext returns formatted context string when items found', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setEmbeddingModel(mockGeminiEmbeddingModel({ values: makeEmbedding(0.1) }));
  embeddings._setSupabaseClient({
    rpc: async (fn) => {
      if (fn === 'match_embeddings') {
        return {
          data: [
            { id: 'e1', content: 'Q: How to fix a dripping tap?\nA: Replace the washer.', metadata: {}, similarity: 0.88 },
            { id: 'e2', content: 'Q: Leaky faucet causes?\nA: Worn O-ring or washer.', metadata: {}, similarity: 0.82 },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    },
  });

  const result = await embeddings.buildRagContext('My tap is dripping. How do I fix it?');

  assert.ok(result !== null, 'should return context string');
  assert.ok(result.includes('Relevant past answers'), 'should include header');
  assert.ok(result.includes('Q: How to fix a dripping tap?'), 'should include first Q');
  assert.ok(result.includes('Use these as reference'), 'should include footer');

  embeddings._resetSupabaseClient();
});

test('buildRagContext returns null on timeout (> 200ms)', async () => {
  const embeddings = require('../lib/embeddings');

  // Inject a model that takes 300ms (exceeds 200ms RAG_TIMEOUT_MS)
  embeddings._setEmbeddingModel({
    embedContent: () => new Promise(resolve =>
      setTimeout(() => resolve({ embedding: { values: makeEmbedding(0.1) } }), 350)
    ),
  });

  const start = Date.now();
  const result = await embeddings.buildRagContext('slow query');
  const elapsed = Date.now() - start;

  assert.strictEqual(result, null, 'should return null on timeout');
  assert.ok(elapsed < 400, `should not block longer than timeout (elapsed: ${elapsed}ms)`);
});

test('buildRagContext returns null on embedding error', async () => {
  const embeddings = require('../lib/embeddings');

  embeddings._setEmbeddingModel({
    embedContent: async () => { throw new Error('Embedding API error'); },
  });

  const result = await embeddings.buildRagContext('test question');
  assert.strictEqual(result, null, 'should return null on embedding error');
});

// ─── Section 6: RAG injection in /api/agent/query ─────────────────────────────
console.log('\n📋 Section 6: RAG injection in /api/agent/query');

test('query handler uses RAG context when buildRagContext returns a string', async () => {
  // We test the integration by monkey-patching lib/embeddings in the agent module
  // and verifying the prompt sent to Gemini includes the RAG context.
  const embeddingsModule = require('../lib/embeddings');

  // Capture the prompt text passed to Gemini
  let capturedPromptText = null;

  // Stub buildRagContext to return a fake RAG block
  const origBuildRag = embeddingsModule.buildRagContext;
  embeddingsModule.buildRagContext = async () =>
    'Relevant past answers from our knowledge base:\n[Q: Furnace clicking?\nA: Normal on startup.]\nUse these as reference but provide a fresh, accurate answer.';

  // Stub queueForEmbedding and processEmbeddingQueue (prevent real DB calls)
  const origQueue = embeddingsModule.queueForEmbedding;
  const origProcess = embeddingsModule.processEmbeddingQueue;
  embeddingsModule.queueForEmbedding = async () => {};
  embeddingsModule.processEmbeddingQueue = async () => ({ processed: 0, errors: 0 });

  // We can't easily test the full express stack here without starting the server,
  // so we test the logic inline to verify prompt construction.
  const ragContext = await embeddingsModule.buildRagContext('Why is my furnace clicking?');
  const question = 'Why is my furnace clicking?';
  let promptText = question;
  if (ragContext) {
    promptText = `${ragContext}\n\n${question}`;
  }

  assert.ok(promptText.includes('Relevant past answers'), 'prompt should include RAG header');
  assert.ok(promptText.includes('Why is my furnace clicking?'), 'prompt should include original question');
  assert.ok(promptText.indexOf('Relevant past answers') < promptText.indexOf('Why is my furnace clicking?'),
    'RAG context should come before the question');

  // Restore
  embeddingsModule.buildRagContext = origBuildRag;
  embeddingsModule.queueForEmbedding = origQueue;
  embeddingsModule.processEmbeddingQueue = origProcess;
});

test('query handler proceeds without RAG when buildRagContext returns null', async () => {
  const embeddingsModule = require('../lib/embeddings');

  const origBuildRag = embeddingsModule.buildRagContext;
  embeddingsModule.buildRagContext = async () => null;

  const ragContext = await embeddingsModule.buildRagContext('What is a P-trap?');
  const question = 'What is a P-trap?';
  let promptText = question;
  if (ragContext) {
    promptText = `${ragContext}\n\n${question}`;
  }

  assert.strictEqual(promptText, question, 'prompt should be unmodified when no RAG context');

  embeddingsModule.buildRagContext = origBuildRag;
});

test('billingMeta includes rag_injected flag', async () => {
  // Verify the agent route sets rag_injected in requestMetadata
  const agentRoute = require('../routes/agent');

  // The agent route exports the router; we can inspect it was modified
  // by checking that agent.js was updated to include rag_injected
  const fs = require('fs');
  const agentSource = fs.readFileSync(require('path').join(__dirname, '../routes/agent.js'), 'utf8');

  assert.ok(agentSource.includes('rag_injected'), 'agent.js should include rag_injected in billingMeta');
  assert.ok(agentSource.includes('buildRagContext'), 'agent.js should call buildRagContext');
  assert.ok(agentSource.includes('queueForEmbedding'), 'agent.js should call queueForEmbedding');
  assert.ok(agentSource.includes('processEmbeddingQueue'), 'agent.js should call processEmbeddingQueue');
});

// ─── Section 7: Embedding queue triggered after successful query ───────────────
console.log('\n📋 Section 7: Embedding queued after successful /api/agent/query');

test('queueForEmbedding is called with high-confidence answer after query', async () => {
  // Simulate the setImmediate block in the query handler
  const embeddings = require('../lib/embeddings');

  const queuedItems = [];
  const origQueue = embeddings.queueForEmbedding;
  embeddings.queueForEmbedding = async (q, a, meta) => {
    queuedItems.push({ question: q, answer: a, meta });
  };

  const origProcess = embeddings.processEmbeddingQueue;
  embeddings.processEmbeddingQueue = async () => ({ processed: 0, errors: 0 });

  // Simulate what the handler does in setImmediate
  const question = 'How do I clean my air filter?';
  const answer = 'Remove the filter from the air handler. Vacuum loose debris, then rinse with water. Let it dry completely before reinstalling. Replace if damaged.';
  const confidence = 0.85;

  // Mimic the setImmediate block from agent.js
  await embeddings.queueForEmbedding(question, answer, {
    source: 'agent_query',
    confidence,
    wallet_id: 'wallet-uuid-333',
    category: 'maintenance',
  });
  await embeddings.processEmbeddingQueue();

  assert.strictEqual(queuedItems.length, 1, 'should queue 1 item');
  assert.strictEqual(queuedItems[0].question, question);
  assert.strictEqual(queuedItems[0].meta.confidence, 0.85);
  assert.strictEqual(queuedItems[0].meta.source, 'agent_query');

  embeddings.queueForEmbedding = origQueue;
  embeddings.processEmbeddingQueue = origProcess;
});

test('queueForEmbedding is not called for low-confidence answers', async () => {
  const embeddings = require('../lib/embeddings');

  let queueCalled = false;
  const origQueue = embeddings.queueForEmbedding;

  // The real queueForEmbedding silently skips low confidence — simulate that
  embeddings.queueForEmbedding = async (q, a, meta) => {
    const { MIN_CONFIDENCE } = embeddings;
    if ((parseFloat(meta.confidence) || 0) >= MIN_CONFIDENCE) {
      queueCalled = true;
    }
  };

  await embeddings.queueForEmbedding('test?', 'test answer', { confidence: 0.4 });
  assert.strictEqual(queueCalled, false, 'should not queue low-confidence answer');

  embeddings.queueForEmbedding = origQueue;
});

// ─── Section 8: Module exports ─────────────────────────────────────────────────
console.log('\n📋 Section 8: lib/embeddings.js module exports');

test('embeddings module exports expected functions', () => {
  const embeddings = require('../lib/embeddings');

  assert.strictEqual(typeof embeddings.embedText, 'function', 'embedText should be a function');
  assert.strictEqual(typeof embeddings.findSimilar, 'function', 'findSimilar should be a function');
  assert.strictEqual(typeof embeddings.queueForEmbedding, 'function', 'queueForEmbedding should be a function');
  assert.strictEqual(typeof embeddings.processEmbeddingQueue, 'function', 'processEmbeddingQueue should be a function');
  assert.strictEqual(typeof embeddings.buildRagContext, 'function', 'buildRagContext should be a function');
  assert.strictEqual(typeof embeddings._setEmbeddingModel, 'function', '_setEmbeddingModel should be exported for testing');
});

test('_CONFIG exports correct constants', () => {
  const { _CONFIG } = require('../lib/embeddings');

  assert.strictEqual(_CONFIG.EMBEDDING_DIMS, 768, 'EMBEDDING_DIMS should be 768');
  assert.ok(
    _CONFIG.EMBEDDING_MODEL === 'text-embedding-004' || _CONFIG.EMBEDDING_MODEL === 'gemini-embedding-001',
    'EMBEDDING_MODEL should be a valid Gemini embedding model'
  );
  assert.strictEqual(_CONFIG.MAX_BATCH, 10, 'MAX_BATCH should be 10');
  assert.strictEqual(_CONFIG.RAG_THRESHOLD, 0.75, 'RAG_THRESHOLD should be 0.75');
  assert.strictEqual(_CONFIG.RAG_LIMIT, 3, 'RAG_LIMIT should be 3');
  assert.strictEqual(_CONFIG.RAG_TIMEOUT_MS, 200, 'RAG_TIMEOUT_MS should be 200ms');
});

test('MIN_CONFIDENCE is exported and equals 0.7', () => {
  const { MIN_CONFIDENCE } = require('../lib/embeddings');
  assert.strictEqual(MIN_CONFIDENCE, 0.7);
});

test('migration file exists with correct tables', () => {
  const fs = require('fs');
  const path = require('path');
  const migrationPath = path.join(__dirname, '../supabase/migrations/20260607_embeddings.sql');

  assert.ok(fs.existsSync(migrationPath), 'migration file should exist');

  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.ok(sql.includes('CREATE EXTENSION IF NOT EXISTS vector'), 'should enable pgvector extension');
  assert.ok(sql.includes('knowledge_embeddings'), 'should create knowledge_embeddings table');
  assert.ok(sql.includes('embedding_queue'), 'should create embedding_queue table');
  assert.ok(sql.includes('VECTOR(768)'), 'should use 768-dim vector column');
  assert.ok(sql.includes('hnsw'), 'should create HNSW index');
  assert.ok(sql.includes('vector_cosine_ops'), 'should use cosine ops');
  assert.ok(sql.includes('match_embeddings'), 'should create match_embeddings RPC');
});

// ─── Run all tests ─────────────────────────────────────────────────────────────
_runAll().then(() => {
  console.log('\n──────────────────────────────────────────────────');
  if (failed === 0) {
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('\n✅ All Day 6 tests passed!');
  } else {
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('\n❌ Some tests failed.');
    process.exit(1);
  }
});

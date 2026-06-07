'use strict';

/**
 * lib/embeddings.js
 *
 * Data Flywheel — Embedding Worker + RAG Utilities
 *
 * Every successful Q&A pair (confidence >= 0.7) is queued for embedding
 * via Gemini text-embedding-004. Embeddings are stored in Supabase with
 * pgvector. Before each Gemini query, we search for similar past answers
 * to inject as RAG context (< 200ms timeout enforced).
 *
 * Public API:
 *   embedText(text)                                → float[] (768 dims)
 *   findSimilar(embedding, limit, threshold)       → [{content, metadata, similarity}]
 *   queueForEmbedding(question, answer, metadata)  → void (fire-and-forget)
 *   processEmbeddingQueue()                        → { processed, errors }
 *
 * Design decisions:
 *   - All DB failures are logged, never thrown — caller always succeeds
 *   - processEmbeddingQueue processes up to MAX_BATCH items per cycle
 *   - embedText is the only function that calls Gemini; all others are pure DB
 *   - Worker is called via setImmediate — never blocks the HTTP response
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
// Internal Supabase reference — injectable for testing via _setSupabaseClient
let _supabase = require('./supabase');
/** @param {object} client Replace the Supabase client (test use only) */
function _setSupabaseClient(client) { _supabase = client; }
/** Restore the real Supabase client after a test */
function _resetSupabaseClient() { _supabase = require('./supabase'); }

// ─── Config ────────────────────────────────────────────────────────────────────
const EMBEDDING_MODEL   = 'text-embedding-004';
const EMBEDDING_DIMS    = 768;
const MAX_BATCH         = 10;         // Max items processed per worker cycle
const MIN_CONFIDENCE    = 0.7;        // Only embed answers meeting this threshold
const RAG_THRESHOLD     = 0.75;       // Min cosine similarity for RAG injection
const RAG_LIMIT         = 3;          // Top-N results to inject
const RAG_TIMEOUT_MS    = 200;        // Max ms to wait for RAG lookup before skipping
const CONTENT_MAX_CHARS = 8000;       // Truncate long content before embedding

// Expose constants for testing
const _CONFIG = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  MAX_BATCH,
  MIN_CONFIDENCE,
  RAG_THRESHOLD,
  RAG_LIMIT,
  RAG_TIMEOUT_MS,
  CONTENT_MAX_CHARS,
};

// ─── Gemini Client (lazy init) ─────────────────────────────────────────────────
let _genAI = null;
let _embeddingModel = null;

function getEmbeddingModel() {
  if (_embeddingModel) return _embeddingModel;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[embeddings] GEMINI_API_KEY not set — embeddings unavailable');
  }

  _genAI = new GoogleGenerativeAI(apiKey);
  _embeddingModel = _genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  return _embeddingModel;
}

// Allow injection of a mock model for testing
function _setEmbeddingModel(mockModel) {
  _embeddingModel = mockModel;
}

// ─── embedText ─────────────────────────────────────────────────────────────────
/**
 * Embed a text string using Gemini text-embedding-004.
 *
 * Returns a float array of length EMBEDDING_DIMS (768).
 * Truncates content to CONTENT_MAX_CHARS before embedding.
 *
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - 768-element float array
 * @throws {Error} if Gemini call fails or API key is missing
 */
async function embedText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('embedText: text must be a non-empty string');
  }

  // Truncate to avoid exceeding model limits
  const truncated = text.length > CONTENT_MAX_CHARS
    ? text.slice(0, CONTENT_MAX_CHARS)
    : text;

  const model = getEmbeddingModel();
  const result = await model.embedContent(truncated);

  const values = result?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMS) {
    throw new Error(
      `embedText: unexpected embedding shape — got ${Array.isArray(values) ? values.length : typeof values} dims, expected ${EMBEDDING_DIMS}`
    );
  }

  return values;
}

// ─── findSimilar ───────────────────────────────────────────────────────────────
/**
 * Find the top-N most similar embeddings in knowledge_embeddings.
 *
 * Uses the match_embeddings Supabase RPC (cosine similarity via pgvector).
 * Falls back to empty array on any DB error.
 *
 * @param {number[]} embedding - 768-element query embedding
 * @param {number}   [limit=RAG_LIMIT]     - Max results to return
 * @param {number}   [threshold=RAG_THRESHOLD] - Min cosine similarity (0–1)
 * @returns {Promise<Array<{id, content, metadata, similarity}>>}
 */
async function findSimilar(embedding, limit = RAG_LIMIT, threshold = RAG_THRESHOLD) {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) {
    console.error(`[embeddings/findSimilar] invalid embedding: expected ${EMBEDDING_DIMS}-dim array, got`, typeof embedding);
    return [];
  }

  try {
    const { data, error } = await _supabase.rpc('match_embeddings', {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: limit,
    });

    if (error) {
      console.error('[embeddings/findSimilar] RPC error:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('[embeddings/findSimilar] unexpected error:', err.message);
    return [];
  }
}

// ─── queueForEmbedding ─────────────────────────────────────────────────────────
/**
 * Add a Q&A pair to the embedding queue (fire-and-forget).
 *
 * Only queues if answer confidence >= MIN_CONFIDENCE.
 * Never throws — all errors are logged.
 *
 * @param {string} question  - The original question
 * @param {string} answer    - The AI-generated answer
 * @param {Object} metadata  - { source, confidence, wallet_id, category, ... }
 */
async function queueForEmbedding(question, answer, metadata = {}) {
  // Gate: only embed high-confidence answers
  const confidence = parseFloat(metadata.confidence) || 0;
  if (confidence < MIN_CONFIDENCE) {
    return; // Silent skip — not an error
  }

  if (!question || !answer) {
    console.error('[embeddings/queueForEmbedding] question and answer are required');
    return;
  }

  // Build the content string we'll embed later.
  // Format: "Q: <question>\nA: <answer>"
  // Stored in embedding_queue.question / .answer (split for worker use).
  try {
    const { error } = await _supabase
      .from('embedding_queue')
      .insert({
        question: question.slice(0, 2000),  // Respect question max length
        answer:   answer.slice(0, 6000),    // Answers can be longer
        metadata: {
          source:    metadata.source    || 'agent_query',
          confidence,
          wallet_id: metadata.wallet_id || null,  // Already anonymized by caller
          category:  metadata.category  || 'maintenance',
        },
        status: 'pending',
      });

    if (error) {
      console.error('[embeddings/queueForEmbedding] insert failed:', error.message);
    }
  } catch (err) {
    console.error('[embeddings/queueForEmbedding] unexpected error:', err.message);
  }
}

// ─── processEmbeddingQueue ─────────────────────────────────────────────────────
/**
 * Worker: pull up to MAX_BATCH pending items from embedding_queue,
 * embed them, store in knowledge_embeddings, mark done.
 *
 * Called via setImmediate in routes/agent.js after a successful response.
 * Never called on the hot path — always deferred.
 *
 * @returns {Promise<{processed: number, errors: number}>}
 */
async function processEmbeddingQueue() {
  let processed = 0;
  let errors = 0;

  try {
    // ── 1. Pull pending items ────────────────────────────────────────────────
    const { data: items, error: fetchError } = await _supabase
      .from('embedding_queue')
      .select('id, question, answer, metadata')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_BATCH);

    if (fetchError) {
      console.error('[embeddings/processQueue] fetch failed:', fetchError.message);
      return { processed, errors };
    }

    if (!items || items.length === 0) {
      return { processed, errors };
    }

    // ── 2. Mark as processing (prevents duplicate processing on retry) ───────
    const ids = items.map(i => i.id);
    await _supabase
      .from('embedding_queue')
      .update({ status: 'processing' })
      .in('id', ids);

    // ── 3. Embed + store each item ───────────────────────────────────────────
    for (const item of items) {
      try {
        // Build content string for embedding
        const content = `Q: ${item.question}\nA: ${item.answer}`;

        // Embed via Gemini
        const embedding = await embedText(content);

        // Store in knowledge_embeddings
        const { error: insertError } = await _supabase
          .from('knowledge_embeddings')
          .insert({
            content,
            embedding,
            metadata: item.metadata || {},
          });

        if (insertError) {
          throw new Error(`knowledge_embeddings insert failed: ${insertError.message}`);
        }

        // Mark done
        await _supabase
          .from('embedding_queue')
          .update({ status: 'done', processed_at: new Date().toISOString() })
          .eq('id', item.id);

        processed++;
      } catch (itemErr) {
        console.error(`[embeddings/processQueue] item ${item.id} failed:`, itemErr.message);
        errors++;

        // Mark error so we don't retry indefinitely
        await _supabase
          .from('embedding_queue')
          .update({ status: 'error', error_msg: itemErr.message.slice(0, 500) })
          .eq('id', item.id)
          .catch(() => {}); // Best-effort
      }
    }
  } catch (err) {
    console.error('[embeddings/processQueue] unexpected error:', err.message);
    errors++;
  }

  return { processed, errors };
}

// ─── buildRagContext ───────────────────────────────────────────────────────────
/**
 * Given a question, embed it, find similar past answers, and return a
 * formatted RAG context string to inject into the Gemini prompt.
 *
 * Enforces RAG_TIMEOUT_MS — returns null if lookup takes too long.
 *
 * @param {string} question
 * @returns {Promise<string|null>} RAG context string, or null if nothing useful found
 */
async function buildRagContext(question) {
  const start = Date.now();

  try {
    // Race against timeout
    const result = await Promise.race([
      _doRagLookup(question),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RAG_TIMEOUT')), RAG_TIMEOUT_MS)
      ),
    ]);

    const elapsed = Date.now() - start;
    if (result && result.length > 0) {
      console.log(`[embeddings/rag] found ${result.length} relevant items in ${elapsed}ms`);
    }
    return result;
  } catch (err) {
    if (err.message === 'RAG_TIMEOUT') {
      console.warn(`[embeddings/rag] timeout after ${RAG_TIMEOUT_MS}ms — skipping RAG`);
    } else {
      console.error('[embeddings/rag] lookup error — skipping RAG:', err.message);
    }
    return null;
  }
}

/**
 * Internal: perform the embed + findSimilar + format pipeline.
 * @param {string} question
 * @returns {Promise<string|null>}
 */
async function _doRagLookup(question) {
  // Embed the question
  const queryEmbedding = await embedText(question);

  // Find similar past answers
  const similar = await findSimilar(queryEmbedding, RAG_LIMIT, RAG_THRESHOLD);

  if (!similar || similar.length === 0) {
    return null;
  }

  // Format RAG context block
  const lines = similar.map(item => {
    // content is stored as "Q: ...\nA: ..."
    // Pass it through as-is, prefixed with brackets for clarity
    return `[${item.content}]`;
  });

  return [
    'Relevant past answers from our knowledge base:',
    ...lines,
    'Use these as reference but provide a fresh, accurate answer.',
  ].join('\n');
}

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  embedText,
  findSimilar,
  queueForEmbedding,
  processEmbeddingQueue,
  buildRagContext,
  // Internals exposed for testing
  _setEmbeddingModel,
  _setSupabaseClient,
  _resetSupabaseClient,
  _CONFIG,
  MIN_CONFIDENCE,
};

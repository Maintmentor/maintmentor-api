'use strict';

/**
 * lib/manuals.js
 *
 * Manual Knowledge Base — full-text search over uploaded PDF manuals.
 *
 * Searches manual_chunks using PostgreSQL full-text search (tsvector/tsquery).
 * Results are injected into the AI prompt alongside the existing RAG context.
 *
 * Public API:
 *   searchManuals(question, opts?)   → [{ title, category, manufacturer, content, rank }]
 *   buildManualContext(question)     → string | null  (formatted for prompt injection)
 */

let _supabase = require('./supabase');

// ─── Config ────────────────────────────────────────────────────────────────────
const SEARCH_LIMIT   = 4;     // Max chunks to retrieve
const MIN_RANK       = 0.01;  // Minimum FTS rank (filters noise)
const TIMEOUT_MS     = 300;   // Max ms before skipping manual lookup

// ─── searchManuals ─────────────────────────────────────────────────────────────
/**
 * Full-text search over manual_chunks.
 *
 * @param {string} question - The user's maintenance question
 * @param {object} [opts]
 * @param {number} [opts.limit=SEARCH_LIMIT]
 * @param {number} [opts.minRank=MIN_RANK]
 * @returns {Promise<Array<{title, category, manufacturer, model_number, content, rank}>>}
 */
async function searchManuals(question, opts = {}) {
  const limit   = opts.limit   ?? SEARCH_LIMIT;
  const minRank = opts.minRank ?? MIN_RANK;

  // Convert question to tsquery — take first 10 meaningful words
  const words = question
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 10);

  if (words.length === 0) return [];

  // Build tsquery: word1 & word2 & word3 | phrase fallback
  const tsQuery = words.join(' & ');

  try {
    const { data, error } = await _supabase.rpc('search_manual_chunks', {
      search_query: tsQuery,
      result_limit: limit,
      min_rank:     minRank,
    });

    if (error) {
      // RPC may not exist yet (tables not created) — fail silently
      console.warn('[manuals/searchManuals] RPC error (may be uncreated):', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.warn('[manuals/searchManuals] unexpected error:', err.message);
    return [];
  }
}

// ─── buildManualContext ────────────────────────────────────────────────────────
/**
 * Search manuals and format results for prompt injection.
 * Returns null if no results or timed out.
 *
 * @param {string} question
 * @returns {Promise<string|null>}
 */
async function buildManualContext(question) {
  try {
    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => resolve(null), TIMEOUT_MS)
    );

    const searchPromise = (async () => {
      const results = await searchManuals(question);
      if (!results || results.length === 0) return null;

      const lines = [
        '=== MANUFACTURER MANUAL EXCERPTS ===',
        'The following is relevant content from uploaded maintenance manuals:',
        '',
      ];

      for (const r of results) {
        const source = [r.title, r.manufacturer, r.model_number]
          .filter(Boolean)
          .join(' — ');
        lines.push(`[Source: ${source}]`);
        lines.push(r.content.trim());
        lines.push('');
      }

      lines.push('=== END MANUAL EXCERPTS ===');
      return lines.join('\n');
    })();

    return await Promise.race([searchPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[manuals/buildManualContext] error:', err.message);
    return null;
  }
}

module.exports = {
  searchManuals,
  buildManualContext,
};

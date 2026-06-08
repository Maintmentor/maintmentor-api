'use strict';

/**
 * maintmentor-client.js
 *
 * Minimal Node.js SDK for the MaintMentor Agent API.
 *
 * Wraps the three primary agent endpoints:
 *   - POST /api/agent/query  — text-based maintenance queries
 *   - POST /api/agent/photo  — image analysis via Gemini Vision
 *   - GET  /api/agent/usage  — wallet balance + usage stats
 *
 * Usage:
 *   const MaintMentor = require('./maintmentor-client');
 *   const client = new MaintMentor({ apiKey: 'mm_pk_...' });
 *
 *   const { answer } = await client.query('Why is my HVAC making noise?');
 *
 * @module maintmentor-client
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_BASE_URL   = 'https://api.maintmentor.ai';
const DEFAULT_TIMEOUT_MS = 30_000;
const SDK_VERSION        = '1.0.0';

// ─── MaintMentorError ──────────────────────────────────────────────────────────

/**
 * Error thrown by the SDK for API-level failures.
 * Contains the HTTP status code and the server's error code string.
 */
class MaintMentorError extends Error {
  /**
   * @param {string} message  - Human-readable error message
   * @param {number} status   - HTTP status code
   * @param {string} code     - Machine-readable error code (e.g. 'INSUFFICIENT_BALANCE')
   */
  constructor(message, status, code) {
    super(message);
    this.name   = 'MaintMentorError';
    this.status = status;
    this.code   = code;
  }
}

// ─── MaintMentorClient ─────────────────────────────────────────────────────────

class MaintMentorClient {
  /**
   * Create a new MaintMentor API client.
   *
   * @param {Object} options
   * @param {string}  options.apiKey      - Your MaintMentor API key (mm_pk_...)
   * @param {string}  [options.baseUrl]   - API base URL (default: https://api.maintmentor.ai)
   * @param {number}  [options.timeout]   - Request timeout in milliseconds (default: 30000)
   * @throws {Error} if apiKey is not provided
   *
   * @example
   * const client = new MaintMentorClient({ apiKey: 'mm_pk_abc123' });
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) {
      throw new Error('MaintMentorClient: apiKey is required');
    }
    if (typeof apiKey !== 'string' || !apiKey.startsWith('mm_pk_')) {
      throw new Error('MaintMentorClient: apiKey must be a string starting with "mm_pk_"');
    }

    this.apiKey  = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
    this.timeout = timeout;
  }

  // ── Internal HTTP helper ───────────────────────────────────────────────────

  /**
   * Make an authenticated HTTP request to the MaintMentor API.
   *
   * @param {string}  method       - HTTP method ('GET', 'POST', etc.)
   * @param {string}  path         - Request path (e.g. '/api/agent/query')
   * @param {Object}  [body=null]  - Request body (will be JSON-serialized)
   * @returns {Promise<Object>}    - Parsed JSON response body
   * @throws {MaintMentorError}    - On HTTP 4xx/5xx responses
   * @throws {Error}               - On network errors or timeouts
   * @private
   */
  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const target  = new URL(path, this.baseUrl);
      const isHttps = target.protocol === 'https:';
      const lib     = isHttps ? https : http;

      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: target.hostname,
        port:     target.port || (isHttps ? 443 : 80),
        path:     target.pathname + target.search,
        method,
        headers: {
          'Authorization':  `Bearer ${this.apiKey}`,
          'Content-Type':   'application/json',
          'Accept':         'application/json',
          'User-Agent':     `maintmentor-sdk-node/${SDK_VERSION}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = lib.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;

          try {
            parsed = JSON.parse(raw);
          } catch {
            // Non-JSON response (e.g. nginx error page)
            return reject(new MaintMentorError(
              `Non-JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`,
              res.statusCode,
              'PARSE_ERROR'
            ));
          }

          if (res.statusCode >= 400) {
            return reject(new MaintMentorError(
              parsed.error || `HTTP ${res.statusCode}`,
              res.statusCode,
              parsed.code  || `HTTP_${res.statusCode}`
            ));
          }

          resolve(parsed);
        });
      });

      // Timeout
      req.setTimeout(this.timeout, () => {
        req.destroy();
        reject(new Error(`MaintMentor request timed out after ${this.timeout}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`MaintMentor network error: ${err.message}`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Submit a text-based maintenance query.
   *
   * Costs 5 credits per call. Rate limited to 100 requests/minute.
   *
   * @param {string}  question              - The maintenance question (required, max 2000 chars)
   * @param {Object}  [options]             - Additional options
   * @param {Object}  [options.context]     - Appliance context (type, model, age)
   * @param {string}  [options.context.appliance_type]  - e.g. "HVAC"
   * @param {string}  [options.context.model]           - e.g. "Carrier 24ACC636A003"
   * @param {number}  [options.context.age_years]       - Appliance age in years
   * @param {string}  [options.response_format]         - "text" (default) or "structured"
   * @returns {Promise<QueryResponse>}
   * @throws {MaintMentorError}  If the request fails (e.g. 402 insufficient balance)
   *
   * @typedef  {Object} QueryResponse
   * @property {string} answer         - AI-generated maintenance guidance
   * @property {number} confidence     - Confidence score (0.0–1.0)
   * @property {number} credits_used   - Credits deducted (always 5)
   * @property {number} wallet_balance - Remaining balance
   * @property {string} request_id     - Unique request ID for support
   *
   * @example
   * const { answer, confidence, wallet_balance } = await client.query(
   *   'My HVAC is making a banging noise on startup',
   *   { context: { appliance_type: 'HVAC', age_years: 8 } }
   * );
   * console.log(answer);
   */
  async query(question, { context, response_format = 'text' } = {}) {
    if (!question || typeof question !== 'string') {
      throw new Error('query: question must be a non-empty string');
    }
    if (question.length > 2000) {
      throw new Error(`query: question exceeds 2000 character limit (got ${question.length})`);
    }

    const body = {
      question,
      ...(context         ? { context }         : {}),
      ...(response_format ? { response_format }  : {}),
    };

    return this._request('POST', '/api/agent/query', body);
  }

  /**
   * Analyze one or more maintenance photos using Gemini Vision.
   *
   * Costs 15 credits per call. Rate limited to 10 requests/minute.
   *
   * @param {string}   question    - Description of what to analyze (max 2000 chars)
   * @param {string[]} images      - Array of base64 data URIs or HTTPS image URLs (max 5)
   * @returns {Promise<PhotoResponse>}
   * @throws {MaintMentorError}    If the request fails
   *
   * @typedef  {Object} PhotoResponse
   * @property {string}   answer        - Detailed visual analysis
   * @property {number}   confidence    - Confidence score (0.0–1.0)
   * @property {string[]} issues_found  - Specific issues detected
   * @property {string}   severity      - "low" | "medium" | "high" | "critical"
   * @property {number}   credits_used  - Credits deducted (always 15)
   * @property {number}   wallet_balance
   * @property {string}   request_id
   *
   * @example
   * const fs = require('fs');
   * const imageData = fs.readFileSync('./ceiling.jpg').toString('base64');
   * const { answer, issues_found } = await client.photo(
   *   'What is causing this stain on my ceiling?',
   *   [`data:image/jpeg;base64,${imageData}`]
   * );
   */
  async photo(question, images) {
    if (!question || typeof question !== 'string') {
      throw new Error('photo: question must be a non-empty string');
    }
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('photo: images must be a non-empty array');
    }
    if (images.length > 5) {
      throw new Error(`photo: maximum 5 images allowed (got ${images.length})`);
    }

    return this._request('POST', '/api/agent/photo', { question, images });
  }

  /**
   * Get wallet balance and usage statistics for the current API key.
   *
   * Free — costs 0 credits.
   *
   * @returns {Promise<UsageResponse>}
   *
   * @typedef  {Object} UsageResponse
   * @property {number} wallet_balance  - Current credit balance
   * @property {Object} today           - { queries, photos, credits_used }
   * @property {Object} this_month      - { queries, photos, credits_used }
   * @property {Object} lifetime        - { queries, photos, credits_used }
   *
   * @example
   * const { wallet_balance, today } = await client.usage();
   * console.log(`Balance: ${wallet_balance} credits | Today: ${today.queries} queries`);
   */
  async usage() {
    return this._request('GET', '/api/agent/usage');
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = MaintMentorClient;
module.exports.MaintMentorClient = MaintMentorClient;
module.exports.MaintMentorError  = MaintMentorError;
module.exports.SDK_VERSION       = SDK_VERSION;

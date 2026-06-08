#!/usr/bin/env node
'use strict';

/**
 * scripts/load-test.js
 *
 * MaintMentor Agent API load test script.
 * Uses Node.js built-in http/https — zero external dependencies.
 *
 * Tests: GET /api/agent/usage (safe, read-only, costs 0 credits)
 * Simulates 10 concurrent requests per wave, running N total waves.
 *
 * Reports:
 *   - p50 / p95 / p99 latency
 *   - min / max / avg latency
 *   - Error rate and breakdown by status code
 *   - Requests per second
 *
 * Usage:
 *   node scripts/load-test.js
 *   node scripts/load-test.js --waves 5 --concurrency 10 --url https://api.maintmentor.ai
 *
 * Options:
 *   --url          API base URL (default: http://localhost:3001)
 *   --concurrency  Concurrent requests per wave (default: 10)
 *   --waves        Number of waves to run (default: 5)
 *   --key          API key to use (default: MAINTMENTOR_TEST_KEY env var or 'mm_pk_test_fake')
 *   --timeout      Request timeout in ms (default: 10000)
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// \u2500\u2500\u2500 Parse CLI args \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function parseArg(name, fallback) {
  const flag = `--${name}`;
  const idx  = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] !== undefined) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const BASE_URL    = parseArg('url',         process.env.MAINTMENTOR_BASE_URL || 'http://localhost:3001');
const CONCURRENCY = parseInt(parseArg('concurrency', '10'), 10);
const WAVES       = parseInt(parseArg('waves',       '5'),  10);
const API_KEY     = parseArg('key', process.env.MAINTMENTOR_TEST_KEY || 'mm_pk_test_loadtest_fake');
const TIMEOUT_MS  = parseInt(parseArg('timeout',     '10000'), 10);
const TARGET_PATH = '/api/agent/usage';

// \u2500\u2500\u2500 HTTP helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Make one GET request and return { durationMs, status }.
 * Never throws \u2014 captures all errors as status -1.
 *
 * @returns {Promise<{ durationMs: number, status: number, error?: string }>}
 */
function makeRequest() {
  return new Promise((resolve) => {
    const start  = Date.now();
    const target = new URL(TARGET_PATH, BASE_URL);
    const lib    = target.protocol === 'https:' ? https : http;

    const options = {
      hostname: target.hostname,
      port:     target.port || (target.protocol === 'https:' ? 443 : 80),
      path:     target.pathname,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept':        'application/json',
        'User-Agent':    'maintmentor-loadtest/1.0',
      },
    };

    const req = lib.request(options, (res) => {
      // Drain response body to free socket
      res.on('data', () => {});
      res.on('end', () => {
        resolve({ durationMs: Date.now() - start, status: res.statusCode });
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ durationMs: Date.now() - start, status: -1, error: 'timeout' });
    });

    req.on('error', (err) => {
      resolve({ durationMs: Date.now() - start, status: -1, error: err.message });
    });

    req.end();
  });
}

// \u2500\u2500\u2500 Stats helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function pad(str, len) {
  return String(str).padStart(len, ' ');
}

// \u2500\u2500\u2500 Main \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

async function main() {
  const totalRequests = CONCURRENCY * WAVES;

  console.log('');
  console.log('\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  console.log('\u2502        MaintMentor Agent API \u2014 Load Test                            \u2502');
  console.log('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
  console.log('');
  console.log(`  Target:       ${BASE_URL}${TARGET_PATH}`);
  console.log(`  API key:      ${API_KEY.slice(0, 12)}...`);
  console.log(`  Concurrency:  ${CONCURRENCY} requests per wave`);
  console.log(`  Waves:        ${WAVES}`);
  console.log(`  Total:        ${totalRequests} requests`);
  console.log(`  Timeout:      ${TIMEOUT_MS}ms`);
  console.log('');
  console.log('  \u26a0\ufe0f  Note: Uses a fake/test API key. Expect 401 responses unless a real key');
  console.log('        is provided via --key or MAINTMENTOR_TEST_KEY env var.');
  console.log('        A 401 still exercises the auth middleware and response path.');
  console.log('');

  const allResults = [];
  const waveTimings = [];

  // \u2500\u2500\u2500 Run waves \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  for (let wave = 1; wave <= WAVES; wave++) {
    process.stdout.write(`  Wave ${wave}/${WAVES}: `);
    const waveStart = Date.now();

    // Launch CONCURRENCY requests in parallel
    const promises = Array.from({ length: CONCURRENCY }, () => makeRequest());
    const results  = await Promise.all(promises);

    const waveDuration = Date.now() - waveStart;
    waveTimings.push(waveDuration);
    allResults.push(...results);

    // Wave summary on one line
    const waveErrors = results.filter(r => r.status < 0 || r.status >= 500).length;
    const waveAvg    = Math.round(avg(results.map(r => r.durationMs)));
    const statusBreakdown = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    const statusStr = Object.entries(statusBreakdown)
      .map(([s, n]) => `${s}\u00d7${n}`)
      .join(', ');

    console.log(`${waveDuration}ms total | avg ${waveAvg}ms/req | statuses: ${statusStr}${waveErrors > 0 ? ` | \u26a0\ufe0f ${waveErrors} errors` : ' | \u2705'}`);
  }

  // \u2500\u2500\u2500 Aggregate stats \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const durations   = allResults.map(r => r.durationMs).sort((a, b) => a - b);
  const successReqs = allResults.filter(r => r.status >= 200 && r.status < 500);
  const errorReqs   = allResults.filter(r => r.status < 0 || r.status >= 500);
  const errorRate   = ((errorReqs.length / allResults.length) * 100).toFixed(1);
  const totalTimeMs = waveTimings.reduce((s, v) => s + v, 0);
  const rps         = (totalRequests / (totalTimeMs / 1000)).toFixed(1);

  // Count by status
  const statusCounts = allResults.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log('\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  console.log('\u2502                    RESULTS                                          \u2502');
  console.log('\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  console.log(`\u2502  Total requests:    ${pad(totalRequests, 6)}                                         \u2502`);
  console.log(`\u2502  Total time:        ${pad(totalTimeMs + 'ms', 9)}                                      \u2502`);
  console.log(`\u2502  Throughput:        ${pad(rps + ' req/s', 12)}                                   \u2502`);
  console.log('\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  console.log('\u2502  Latency (all requests):                                            \u2502');
  console.log(`\u2502    min:  ${pad(durations[0] + 'ms', 8)}                                                \u2502`);
  console.log(`\u2502    p50:  ${pad(percentile(durations, 50) + 'ms', 8)}                                                \u2502`);
  console.log(`\u2502    p95:  ${pad(percentile(durations, 95) + 'ms', 8)}                                                \u2502`);
  console.log(`\u2502    p99:  ${pad(percentile(durations, 99) + 'ms', 8)}                                                \u2502`);
  console.log(`\u2502    max:  ${pad(durations[durations.length - 1] + 'ms', 8)}                                                \u2502`);
  console.log(`\u2502    avg:  ${pad(Math.round(avg(durations)) + 'ms', 8)}                                                \u2502`);
  console.log('\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  console.log('\u2502  Status Codes:                                                       \u2502');
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    const label = status === '-1' ? 'error/timeout' : `HTTP ${status}`;
    console.log(`\u2502    ${pad(label, 20)} ${pad(count, 4)} requests                                \u2502`);
  }
  console.log('\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  console.log(`\u2502  Error rate:        ${pad(errorRate + '%', 7)} (server errors + network failures)    \u2502`);
  console.log(`\u2502  Success (2xx-4xx): ${pad(successReqs.length, 6)} requests                                    \u2502`);

  const verdict = errorRate < 1 ? '\u2705 PASS' : errorRate < 5 ? '\u26a0\ufe0f  WARN' : '\u274c FAIL';
  console.log('\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  console.log(`\u2502  Verdict:   ${verdict}                                                   \u2502`);
  console.log('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
  console.log('');

  // Exit with error if server errors > 1%
  if (parseFloat(errorRate) >= 1) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Load test fatal error:', err.message);
  process.exit(1);
});

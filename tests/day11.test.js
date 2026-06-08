'use strict';

/**
 * tests/day11.test.js
 *
 * Day 11 verification tests:
 *   1. Swagger UI route is registered in server.js at /api/docs
 *   2. swagger-ui-express and js-yaml are installed
 *   3. server.js wires sendDailyAnomalySummary (60s + 24h)
 *   4. Frontend dashboard has API tab (ApiDashboard component)
 *   5. Frontend has Developers page at /developers
 *   6. openapi.yaml exists and is valid YAML
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const OPENAPI_YAML = path.join(__dirname, '..', 'docs', 'openapi.yaml');
const FRONTEND_ROOT = path.join('/root', 'maintenance-mentor-app', 'src');
const APP_TSX = path.join(FRONTEND_ROOT, 'App.tsx');
const DASHBOARD_COMPONENT = path.join(FRONTEND_ROOT, 'components', 'Dashboard.tsx');
const API_DASHBOARD_COMPONENT = path.join(FRONTEND_ROOT, 'components', 'ApiDashboard.tsx');
const DEVELOPERS_PAGE = path.join(FRONTEND_ROOT, 'pages', 'Developers.tsx');

// ─── Helper ─────────────────────────────────────────────────────────────────────
function readFile(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${e.message}`);
  }
}

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

// ─── Tests ───────────────────────────────────────────────────────────────────────
console.log('\n📋 Day 11 Tests\n');

// 1. swagger-ui-express installed
test('swagger-ui-express is installed', () => {
  const pkg = path.join(__dirname, '..', 'node_modules', 'swagger-ui-express', 'package.json');
  assert.ok(fs.existsSync(pkg), 'swagger-ui-express not found in node_modules');
});

// 2. js-yaml installed
test('js-yaml is installed', () => {
  const pkg = path.join(__dirname, '..', 'node_modules', 'js-yaml', 'package.json');
  assert.ok(fs.existsSync(pkg), 'js-yaml not found in node_modules');
});

// 3. openapi.yaml exists
test('docs/openapi.yaml exists', () => {
  assert.ok(fs.existsSync(OPENAPI_YAML), 'docs/openapi.yaml not found');
});

// 4. openapi.yaml is parseable YAML
test('docs/openapi.yaml is valid YAML with openapi key', () => {
  const yaml = require('js-yaml');
  const content = readFile(OPENAPI_YAML, 'openapi.yaml');
  const doc = yaml.load(content);
  assert.ok(doc && doc.openapi, 'openapi.yaml must have an "openapi" key');
});

// 5. server.js requires swagger-ui-express
test('server.js requires swagger-ui-express', () => {
  const content = readFile(SERVER_JS, 'server.js');
  assert.ok(
    content.includes("require('swagger-ui-express')"),
    'server.js must require swagger-ui-express'
  );
});

// 6. server.js requires js-yaml
test('server.js requires js-yaml', () => {
  const content = readFile(SERVER_JS, 'server.js');
  assert.ok(
    content.includes("require('js-yaml')"),
    'server.js must require js-yaml'
  );
});

// 7. server.js registers Swagger UI at /api/docs
test('server.js registers swaggerUi.setup at /api/docs', () => {
  const content = readFile(SERVER_JS, 'server.js');
  assert.ok(
    content.includes('/api/docs'),
    'server.js must register /api/docs route'
  );
  assert.ok(
    content.includes('swaggerUi.setup'),
    'server.js must call swaggerUi.setup'
  );
});

// 8. server.js serves both /api/docs and /api/docs/
test('server.js serves both /api/docs and /api/docs/ paths', () => {
  const content = readFile(SERVER_JS, 'server.js');
  // Either an explicit redirect OR an array route covering both paths
  const hasExplicitRedirect = content.includes("res.redirect('/api/docs/')");
  const hasArrayRoute = content.includes("'/api/docs/', '/api/docs'") ||
    content.includes("'/api/docs', '/api/docs/'") ||
    content.includes('"/api/docs", "/api/docs/"') ||
    content.includes('"/api/docs/", "/api/docs"') ||
    (content.includes('[') && content.includes('/api/docs') && content.includes('swaggerSetupFn'));
  assert.ok(
    hasExplicitRedirect || hasArrayRoute,
    'server.js must handle both /api/docs and /api/docs/ (redirect or array route)'
  );
});

// 9. server.js imports sendDailyAnomalySummary
test('server.js imports sendDailyAnomalySummary from anomalyDetector', () => {
  const content = readFile(SERVER_JS, 'server.js');
  assert.ok(
    content.includes('sendDailyAnomalySummary'),
    'server.js must reference sendDailyAnomalySummary'
  );
});

// 10. server.js has 60-second delayed first run
test('server.js wires 60s initial delay for anomaly digest', () => {
  const content = readFile(SERVER_JS, 'server.js');
  assert.ok(
    content.includes('60 * 1000') || content.includes('60000'),
    'server.js must have a 60s (60 * 1000) initial timeout for anomaly digest'
  );
});

// 11. server.js has 24h recurring interval
test('server.js wires 24h interval for anomaly digest', () => {
  const content = readFile(SERVER_JS, 'server.js');
  assert.ok(
    content.includes('24 * 60 * 60 * 1000') || content.includes('86400000'),
    'server.js must have a 24h interval for anomaly digest'
  );
});

// 12. sendDailyAnomalySummary is exported from anomalyDetector
test('anomalyDetector.js exports sendDailyAnomalySummary', () => {
  const detectorPath = path.join(__dirname, '..', 'lib', 'anomalyDetector.js');
  const content = readFile(detectorPath, 'anomalyDetector.js');
  assert.ok(
    content.includes('sendDailyAnomalySummary'),
    'anomalyDetector.js must export sendDailyAnomalySummary'
  );
  assert.ok(
    content.includes('module.exports') && content.includes('sendDailyAnomalySummary'),
    'sendDailyAnomalySummary must be in module.exports'
  );
});

// 13. ApiDashboard component exists
test('Frontend: ApiDashboard component exists', () => {
  assert.ok(
    fs.existsSync(API_DASHBOARD_COMPONENT),
    `ApiDashboard.tsx not found at ${API_DASHBOARD_COMPONENT}`
  );
});

// 14. ApiDashboard shows wallet balance
test('Frontend: ApiDashboard renders wallet balance', () => {
  const content = readFile(API_DASHBOARD_COMPONENT, 'ApiDashboard.tsx');
  assert.ok(
    content.includes('Wallet') || content.includes('wallet'),
    'ApiDashboard.tsx must show wallet balance'
  );
  assert.ok(
    content.includes('balance') || content.includes('credits'),
    'ApiDashboard.tsx must display credit balance'
  );
});

// 15. ApiDashboard shows API keys
test('Frontend: ApiDashboard renders API keys list', () => {
  const content = readFile(API_DASHBOARD_COMPONENT, 'ApiDashboard.tsx');
  assert.ok(
    content.includes('api_keys') || content.includes('apiKeys') || content.includes('API Keys'),
    'ApiDashboard.tsx must render API keys'
  );
});

// 16. ApiDashboard has revoke/delete
test('Frontend: ApiDashboard has revoke functionality', () => {
  const content = readFile(API_DASHBOARD_COMPONENT, 'ApiDashboard.tsx');
  assert.ok(
    content.includes('DELETE') || content.includes('revoke') || content.includes('Revoke'),
    'ApiDashboard.tsx must have revoke functionality'
  );
});

// 17. Dashboard.tsx imports and renders ApiDashboard
test('Frontend: Dashboard.tsx includes API tab with ApiDashboard', () => {
  const content = readFile(DASHBOARD_COMPONENT, 'Dashboard.tsx');
  assert.ok(
    content.includes('ApiDashboard'),
    'Dashboard.tsx must import and render ApiDashboard'
  );
  assert.ok(
    content.includes('value="api"') || content.includes("value='api'"),
    'Dashboard.tsx must have an API tab'
  );
});

// 18. Developers page exists
test('Frontend: Developers.tsx page exists at /developers', () => {
  assert.ok(
    fs.existsSync(DEVELOPERS_PAGE),
    `Developers.tsx not found at ${DEVELOPERS_PAGE}`
  );
});

// 19. Developers page has Swagger link
test('Frontend: Developers.tsx links to Swagger UI', () => {
  const content = readFile(DEVELOPERS_PAGE, 'Developers.tsx');
  assert.ok(
    content.includes('api.maintmentor.ai/api/docs'),
    'Developers.tsx must link to the Swagger UI at api.maintmentor.ai/api/docs'
  );
});

// 20. Developers page has pricing table
test('Frontend: Developers.tsx shows pricing (5 cr / 15 cr)', () => {
  const content = readFile(DEVELOPERS_PAGE, 'Developers.tsx');
  assert.ok(
    content.includes('5') && content.includes('15'),
    'Developers.tsx must show pricing: 5 credits / 15 credits'
  );
});

// 21. Developers page has code snippet
test('Frontend: Developers.tsx has quick-start code snippet', () => {
  const content = readFile(DEVELOPERS_PAGE, 'Developers.tsx');
  assert.ok(
    content.includes('npm install') || content.includes('curl') || content.includes('Bearer'),
    'Developers.tsx must have a quick-start code snippet'
  );
});

// 22. App.tsx routes /developers
test('Frontend: App.tsx registers /developers route', () => {
  const content = readFile(APP_TSX, 'App.tsx');
  assert.ok(
    content.includes('/developers'),
    'App.tsx must have a /developers route'
  );
  assert.ok(
    content.includes('DevelopersPage') || content.includes('Developers'),
    'App.tsx must import the Developers page component'
  );
});

console.log('\n✅ Day 11 test run complete.\n');

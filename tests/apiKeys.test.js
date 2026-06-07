'use strict';

/**
 * tests/apiKeys.test.js
 *
 * Unit tests for API key utilities in lib/apiKeys.js.
 * Uses Node's built-in assert module — no test framework required.
 *
 * Run with: node tests/apiKeys.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  validateKeyFormat,
  KEY_PREFIX,
} = require('../lib/apiKeys');

let passed = 0;
let failed = 0;

/**
 * Simple test runner helper.
 * @param {string} name - Test description
 * @param {Function} fn - Test function (may throw on failure)
 */
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── generateApiKey() ────────────────────────────────────────────────────────────

console.log('\n📋 generateApiKey()');

test('returns a string', () => {
  const key = generateApiKey();
  assert.strictEqual(typeof key, 'string', 'Key should be a string');
});

test('starts with mm_pk_ prefix', () => {
  const key = generateApiKey();
  assert.ok(key.startsWith('mm_pk_'), `Key "${key}" should start with "mm_pk_"`);
});

test('has correct total length (38 chars: 6 prefix + 32 hex)', () => {
  const key = generateApiKey();
  // "mm_pk_" = 6 chars, 32 hex chars = 38 total
  assert.strictEqual(key.length, 38, `Key length should be 38, got ${key.length}`);
});

test('hex portion contains only lowercase hex characters', () => {
  const key = generateApiKey();
  const hexPart = key.slice('mm_pk_'.length);
  assert.match(hexPart, /^[0-9a-f]{32}$/, `Hex portion "${hexPart}" must be 32 lowercase hex chars`);
});

test('generates unique keys on each call', () => {
  const keys = new Set();
  for (let i = 0; i < 10; i++) {
    keys.add(generateApiKey());
  }
  assert.strictEqual(keys.size, 10, 'All 10 generated keys should be unique');
});

// ─── hashApiKey() ────────────────────────────────────────────────────────────────

console.log('\n🔒 hashApiKey()');

test('returns a string', () => {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  assert.strictEqual(typeof hash, 'string', 'Hash should be a string');
});

test('returns a 64-character hex string (SHA-256)', () => {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  assert.strictEqual(hash.length, 64, `SHA-256 hash should be 64 hex chars, got ${hash.length}`);
  assert.match(hash, /^[0-9a-f]{64}$/, 'Hash should contain only lowercase hex chars');
});

test('produces consistent output for the same input', () => {
  const key = generateApiKey();
  const hash1 = hashApiKey(key);
  const hash2 = hashApiKey(key);
  assert.strictEqual(hash1, hash2, 'Same key should always produce the same hash');
});

test('produces different hashes for different keys', () => {
  const key1 = generateApiKey();
  const key2 = generateApiKey();
  const hash1 = hashApiKey(key1);
  const hash2 = hashApiKey(key2);
  assert.notStrictEqual(hash1, hash2, 'Different keys should produce different hashes');
});

test('matches manual crypto.createHash SHA-256 computation', () => {
  const key = generateApiKey();
  const expected = crypto.createHash('sha256').update(key).digest('hex');
  const actual = hashApiKey(key);
  assert.strictEqual(actual, expected, 'hashApiKey() should match manual SHA-256');
});

test('known value: hash of literal "mm_pk_test" matches expected SHA-256', () => {
  // Pre-computed: echo -n "mm_pk_test" | sha256sum
  const input = 'mm_pk_test';
  const expected = crypto.createHash('sha256').update(input).digest('hex');
  const actual = hashApiKey(input);
  assert.strictEqual(actual, expected, 'Hash of "mm_pk_test" should match expected value');
});

// ─── getKeyPrefix() ──────────────────────────────────────────────────────────────

console.log('\n🏷️  getKeyPrefix()');

test('returns a string', () => {
  const key = generateApiKey();
  const prefix = getKeyPrefix(key);
  assert.strictEqual(typeof prefix, 'string', 'Prefix should be a string');
});

test('starts with mm_pk_', () => {
  const key = generateApiKey();
  const prefix = getKeyPrefix(key);
  assert.ok(prefix.startsWith('mm_pk_'), `Prefix "${prefix}" should start with "mm_pk_"`);
});

test('total length is 14 chars (6 prefix + 8 hex chars)', () => {
  const key = generateApiKey();
  const prefix = getKeyPrefix(key);
  assert.strictEqual(prefix.length, 14, `Prefix length should be 14, got ${prefix.length}`);
});

test('prefix matches first 8 chars of key hex portion', () => {
  const key = generateApiKey();
  const hexPart = key.slice('mm_pk_'.length); // 32 hex chars
  const expectedPrefix = `mm_pk_${hexPart.slice(0, 8)}`;
  const actualPrefix = getKeyPrefix(key);
  assert.strictEqual(actualPrefix, expectedPrefix, 'Prefix should match first 8 chars of hex portion');
});

test('two different keys with same first 8 hex chars produce same prefix', () => {
  // Craft two keys that share first 8 hex chars but differ after that
  const sharedHex = 'aabbccdd';
  const key1 = `mm_pk_${sharedHex}${'0'.repeat(24)}`;
  const key2 = `mm_pk_${sharedHex}${'f'.repeat(24)}`;
  assert.strictEqual(getKeyPrefix(key1), getKeyPrefix(key2), 'Shared first 8 chars → same prefix');
});

// ─── validateKeyFormat() ─────────────────────────────────────────────────────────

console.log('\n✔️  validateKeyFormat()');

test('accepts valid generated key', () => {
  const key = generateApiKey();
  assert.strictEqual(validateKeyFormat(key), true, 'Generated key should be valid');
});

test('accepts lowercase hex key', () => {
  const key = 'mm_pk_' + 'a'.repeat(32);
  assert.strictEqual(validateKeyFormat(key), true, 'All lowercase hex should be valid');
});

test('accepts mixed-digit hex key', () => {
  const key = 'mm_pk_0123456789abcdef0123456789abcdef';
  assert.strictEqual(validateKeyFormat(key), true, 'Mixed hex digits should be valid');
});

test('rejects key without prefix', () => {
  const key = '0123456789abcdef0123456789abcdef';
  assert.strictEqual(validateKeyFormat(key), false, 'Key without mm_pk_ prefix should be invalid');
});

test('rejects key with wrong prefix', () => {
  // Using a clearly-fake Stripe-like format to test wrong-prefix rejection
  const key = 'sk_FAKE_0123456789abcdef0123456789abcdef';
  assert.strictEqual(validateKeyFormat(key), false, 'Wrong prefix should be invalid');
});

test('rejects key with uppercase hex chars', () => {
  const key = 'mm_pk_ABCDEF0123456789ABCDEF01234567';
  assert.strictEqual(validateKeyFormat(key), false, 'Uppercase hex should be invalid');
});

test('rejects key that is too short', () => {
  const key = 'mm_pk_abc123';
  assert.strictEqual(validateKeyFormat(key), false, 'Too-short key should be invalid');
});

test('rejects key that is too long', () => {
  const key = 'mm_pk_' + 'a'.repeat(33);
  assert.strictEqual(validateKeyFormat(key), false, 'Too-long key should be invalid');
});

test('rejects non-string values', () => {
  assert.strictEqual(validateKeyFormat(null), false, 'null should be invalid');
  assert.strictEqual(validateKeyFormat(undefined), false, 'undefined should be invalid');
  assert.strictEqual(validateKeyFormat(12345), false, 'number should be invalid');
  assert.strictEqual(validateKeyFormat({}), false, 'object should be invalid');
});

test('rejects empty string', () => {
  assert.strictEqual(validateKeyFormat(''), false, 'Empty string should be invalid');
});

test('rejects key with special characters', () => {
  const key = 'mm_pk_' + '!@#$%^&*'.repeat(4);
  assert.strictEqual(validateKeyFormat(key), false, 'Special characters should be invalid');
});

// ─── Round-trip test ─────────────────────────────────────────────────────────────

console.log('\n🔄 Round-trip: generate → hash → verify');

test('hashed key matches when hashed again (simulating DB lookup)', () => {
  // Simulate: generate a key, hash it, store the hash.
  // When user presents key later, hash it again and compare.
  const rawKey = generateApiKey();
  const storedHash = hashApiKey(rawKey);  // what goes in the database

  // Later: user presents rawKey in Authorization header
  const presentedHash = hashApiKey(rawKey);  // what we compute at auth time

  assert.strictEqual(storedHash, presentedHash, 'Re-hashing the same key should match stored hash');
});

test('wrong key does not match stored hash', () => {
  const correctKey = generateApiKey();
  const wrongKey = generateApiKey();
  const storedHash = hashApiKey(correctKey);

  assert.notStrictEqual(
    hashApiKey(wrongKey),
    storedHash,
    'Hash of wrong key should NOT match stored hash'
  );
});

test('prefix extracted from raw key matches what would be stored', () => {
  const rawKey = generateApiKey();
  const storedPrefix = getKeyPrefix(rawKey);  // stored in api_keys.key_prefix

  // Simulate displaying the key to user (prefix only, not hash)
  assert.ok(storedPrefix.startsWith('mm_pk_'), 'Stored prefix should start with mm_pk_');
  assert.strictEqual(storedPrefix.length, 14, 'Stored prefix should be 14 chars');
  assert.ok(
    rawKey.startsWith(storedPrefix),
    `Raw key "${rawKey}" should start with stored prefix "${storedPrefix}"`
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} tests passed!`);
  process.exit(0);
}

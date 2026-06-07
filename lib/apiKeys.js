'use strict';

/**
 * lib/apiKeys.js
 *
 * Utility functions for generating, hashing, and validating
 * MaintMentor API keys. All cryptographic operations use Node's
 * built-in `crypto` module — no external packages.
 *
 * Key format: mm_pk_<32 hex chars>
 * Example:    mm_pk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
 *
 * SECURITY RULES:
 *   - Raw keys are NEVER stored in the database
 *   - Raw keys are returned ONCE at creation time only
 *   - Only SHA-256 hashes are persisted
 *   - Prefixes (first 8 chars after mm_pk_) are stored for display only
 */

const crypto = require('crypto');

const KEY_PREFIX = 'mm_pk_';
const KEY_REGEX = /^mm_pk_[0-9a-f]{32}$/;

/**
 * Generates a new raw API key.
 * Format: mm_pk_ followed by 32 lowercase hex characters (16 random bytes).
 *
 * @returns {string} The raw API key — show once, never store.
 */
function generateApiKey() {
  const randomHex = crypto.randomBytes(16).toString('hex');
  return `${KEY_PREFIX}${randomHex}`;
}

/**
 * Hashes a raw API key using SHA-256.
 * The hash is what gets stored in the database.
 *
 * @param {string} rawKey - The full raw API key (mm_pk_...)
 * @returns {string} Hex-encoded SHA-256 hash of the raw key.
 */
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Returns the display prefix for an API key.
 * Shows the first 8 characters of the random portion,
 * formatted as mm_pk_XXXXXXXX — safe to store and display.
 *
 * @param {string} rawKey - The full raw API key (mm_pk_...)
 * @returns {string} Display prefix, e.g. "mm_pk_a1b2c3d4"
 */
function getKeyPrefix(rawKey) {
  // rawKey = "mm_pk_" + 32 hex chars
  // Prefix = "mm_pk_" + first 8 chars of the hex portion
  const hexPart = rawKey.slice(KEY_PREFIX.length); // 32 hex chars
  return `${KEY_PREFIX}${hexPart.slice(0, 8)}`;
}

/**
 * Validates that a string matches the expected API key format.
 * Does NOT check whether the key exists or is active in the database.
 *
 * @param {string} key - The key string to validate.
 * @returns {boolean} True if the format is valid, false otherwise.
 */
function validateKeyFormat(key) {
  if (typeof key !== 'string') return false;
  return KEY_REGEX.test(key);
}

module.exports = {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  validateKeyFormat,
  KEY_PREFIX,
};

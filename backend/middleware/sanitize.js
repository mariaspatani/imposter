'use strict';

/**
 * Input sanitization / validation helpers.
 * Also provides a safe HTML escaper for all user-controlled values
 * rendered into HTML responses.
 */

/**
 * Escape HTML special characters to prevent XSS.
 * Use this on ANY user-supplied value that ends up in innerHTML.
 */
function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate a GitHub repository URL.
 * Returns true only for well-formed public github.com/owner/repo URLs.
 * Explicitly rejects .git suffix (not a valid web URL; causes GitHub API 404).
 */
function isValidGitHubUrl(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (/\.git\/?$/i.test(v)) return false;  // .git suffix is not a valid repo web URL
  return /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+\/?$/i.test(v);
}

/**
 * Sanitize a participant or team name.
 * Allows letters, digits, spaces, hyphens, apostrophes.
 * Returns null if invalid.
 */
function sanitizeName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  return trimmed;
}

/**
 * Validate a UUID string.
 */
function isUUID(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * Clamp a number to [min, max], returning defaultValue if not a valid finite number.
 * Uses Math.min/max first so Infinity/-Infinity resolve to the bounds rather than defaultValue.
 */
function clampScore(value, min, max, defaultValue = 0) {
  const n = Number(value);
  if (isNaN(n)) return defaultValue;
  return Math.min(max, Math.max(min, n));
}

/**
 * Strip path-traversal characters from a ZIP entry name.
 * Returns null if the entry looks unsafe.
 */
function safeZipEntry(entryName) {
  if (typeof entryName !== 'string') return null;
  if (entryName.includes('..') || entryName.startsWith('/') || entryName.includes('\0')) return null;
  return entryName;
}

module.exports = { escHtml, isValidGitHubUrl, sanitizeName, isUUID, clampScore, safeZipEntry };

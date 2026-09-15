'use strict';

/**
 * groqKeyPool.js
 *
 * Manages a pool of Groq API keys to work around per-key rate limits.
 *
 * Key resolution order (highest priority first):
 *   1. GROQ_API_KEY_1 … GROQ_API_KEY_10  (dedicated pool keys)
 *   2. GROQ_API_KEY                       (legacy single-key fallback)
 *
 * Rotation strategy: strict round-robin across all healthy keys.
 * When a key receives a 429 (rate_limit_exceeded) or 413 response it is put
 * into a cooldown window (default 60 s).  During cooldown the pool skips that
 * key and moves to the next one.  Once the window expires the key is
 * automatically re-admitted.
 *
 * Usage
 * -----
 *   const pool = getKeyPool();        // singleton
 *   const key  = pool.next();         // pick next healthy key (throws if none)
 *   pool.markRateLimited(key);        // call on 429 / 413
 *   pool.markSuccess(key);            // optional — resets consecutive error count
 */

const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute per key after a 429

class GroqKeyPool {
  /**
   * @param {string[]} keys         Ordered list of API keys
   * @param {number}   cooldownMs   How long (ms) a rate-limited key is skipped
   */
  constructor(keys, cooldownMs = DEFAULT_COOLDOWN_MS) {
    if (!keys || keys.length === 0) {
      throw new Error('GroqKeyPool requires at least one API key.');
    }
    this._keys = keys;
    this._cooldownMs = cooldownMs;
    // key → timestamp when cooldown expires (0 = no cooldown)
    this._cooldownUntil = new Map(keys.map(k => [k, 0]));
    // Index of the next key to attempt (round-robin cursor)
    this._cursor = 0;
  }

  /** Total number of keys in the pool (including cooled-down ones). */
  get size() { return this._keys.length; }

  /**
   * Returns true if the key is currently healthy (not in cooldown).
   * @param {string} key
   */
  isHealthy(key) {
    return Date.now() >= (this._cooldownUntil.get(key) || 0);
  }

  /**
   * Put a key into cooldown.  Safe to call multiple times — resets the timer
   * so that bursting 429s don't stack.
   * @param {string} key
   * @param {number} [overrideMs]  Optional override for this specific cooldown
   */
  markRateLimited(key, overrideMs) {
    const dur = overrideMs !== undefined ? overrideMs : this._cooldownMs;
    this._cooldownUntil.set(key, Date.now() + dur);
    console.warn(`[GroqKeyPool] Key ...${key.slice(-6)} is rate-limited — cooling for ${dur / 1000}s`);
  }

  /**
   * Mark a key as healthy (e.g. after a successful response).
   * Clears any active cooldown so the key re-enters rotation immediately.
   * @param {string} key
   */
  markSuccess(key) {
    this._cooldownUntil.set(key, 0);
  }

  /**
   * Pick the next healthy key in round-robin order.
   * Throws if every key is currently in cooldown.
   * @returns {string} API key
   */
  next() {
    const total = this._keys.length;
    // Try each key starting at the current cursor position
    for (let i = 0; i < total; i++) {
      const idx = (this._cursor + i) % total;
      const key = this._keys[idx];
      if (this.isHealthy(key)) {
        // Advance cursor past this key for the next call
        this._cursor = (idx + 1) % total;
        return key;
      }
    }

    // All keys are cooled down — return the one whose cooldown expires soonest
    // and log a warning so operators can see pressure.
    let soonestKey = this._keys[0];
    let soonestExp = this._cooldownUntil.get(soonestKey) || 0;
    for (const k of this._keys) {
      const exp = this._cooldownUntil.get(k) || 0;
      if (exp < soonestExp) { soonestExp = exp; soonestKey = k; }
    }
    const waitSec = Math.max(0, Math.ceil((soonestExp - Date.now()) / 1000));
    throw new Error(
      `All ${total} Groq API keys are rate-limited. ` +
      `Fastest recovery in ~${waitSec}s. ` +
      'Add more keys via GROQ_API_KEY_1...GROQ_API_KEY_10.'
    );
  }

  /**
   * Returns a summary of pool health for logging / diagnostics.
   */
  status() {
    const now = Date.now();
    return this._keys.map((k, idx) => {
      const until = this._cooldownUntil.get(k) || 0;
      const coolingSec = until > now ? Math.ceil((until - now) / 1000) : 0;
      return {
        index: idx + 1,
        suffix: k.slice(-6),
        healthy: coolingSec === 0,
        cooldown_remaining_s: coolingSec,
      };
    });
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────

let _instance = null;

/**
 * Returns the singleton GroqKeyPool, building it from environment variables
 * on first call.  Subsequent calls return the cached instance.
 *
 * Key discovery (in order):
 *   GROQ_API_KEY_1, GROQ_API_KEY_2, …, GROQ_API_KEY_10
 *   GROQ_API_KEY  (fallback if none of the numbered keys are set)
 */
function getKeyPool() {
  if (_instance) return _instance;

  const numbered = [];
  for (let i = 1; i <= 10; i++) {
    const v = (process.env[`GROQ_API_KEY_${i}`] || '').trim();
    if (v) numbered.push(v);
  }

  const legacy = (process.env.GROQ_API_KEY || '').trim();

  // Deduplicate while preserving order
  const seen = new Set();
  const allKeys = [...numbered, legacy].filter(k => {
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (allKeys.length === 0) {
    // Return a dummy pool that throws a clear error at call time
    console.warn('[GroqKeyPool] No Groq API keys found in environment.');
    _instance = new GroqKeyPool(['__missing__']);
    // Mark it as permanently cooled so next() always throws the "all cooled down" message
    _instance._cooldownUntil.set('__missing__', Date.now() + 365 * 24 * 3600 * 1000);
    return _instance;
  }

  console.log(`[GroqKeyPool] Initialised with ${allKeys.length} key(s) ` +
    `(suffixes: ${allKeys.map(k => '...' + k.slice(-6)).join(', ')})`);

  _instance = new GroqKeyPool(allKeys);
  return _instance;
}

/**
 * Reset the singleton (useful for tests or hot-reload scenarios).
 */
function resetKeyPool() {
  _instance = null;
}

module.exports = { GroqKeyPool, getKeyPool, resetKeyPool };

'use strict';

/**
 * Rate-limiting middleware using a simple in-memory token-bucket.
 * This is sufficient for a single-instance local/Vercel deployment with ~24 users.
 *
 * For high-traffic or multi-instance deployments, replace with
 * a Redis-backed solution (e.g. upstash-ratelimit).
 */

class TokenBucket {
  constructor(capacity, refillRatePerSecond) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSecond;
    this.lastRefill = Date.now();
  }

  consume() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// Stores: ip → TokenBucket
const buckets = new Map();

// Cleanup stale buckets every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.lastRefill < cutoff) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

/**
 * Factory: create a rate-limit middleware.
 * @param {number} capacity   Max burst (tokens)
 * @param {number} rps        Refill rate in tokens per second
 * @param {string} [keyPrefix] Namespace for this limiter
 */
function createRateLimiter(capacity, rps, keyPrefix = 'default') {
  return function rateLimitMiddleware(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress
              || 'unknown';
    const key = `${keyPrefix}:${ip}`;

    if (!buckets.has(key)) {
      buckets.set(key, new TokenBucket(capacity, rps));
    }

    if (buckets.get(key).consume()) {
      return next();
    }

    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait a moment before trying again.'
    });
  };
}

// Pre-built limiters for each sensitive endpoint category
const authLimiter    = createRateLimiter(10, 0.5, 'auth');    // 10 burst, 1 per 2s
const submitLimiter  = createRateLimiter(5,  0.1, 'submit');  // 5 burst, 1 per 10s
const evalLimiter    = createRateLimiter(3,  0.05,'eval');    // 3 burst, 1 per 20s
const registerLimiter= createRateLimiter(10, 0.3, 'reg');     // 10 burst, 1 per 3s
const adminLimiter   = createRateLimiter(30, 1,   'admin');   // 30 burst, 1 per sec

module.exports = { createRateLimiter, authLimiter, submitLimiter, evalLimiter, registerLimiter, adminLimiter };

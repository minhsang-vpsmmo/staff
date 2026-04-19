'use strict';

const { getPool } = require('../config/db');
const { RateLimitError } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.child({ module: 'rate-limit' });

/**
 * MySQL-backed sliding window rate limiter using rate_limit_buckets table.
 * Atomic via INSERT ON DUPLICATE KEY UPDATE.
 *
 * @param {{ max: number, windowMin: number, keyFn: (req) => string }} opts
 */
function createRateLimit({ max, windowMin, keyFn }) {
  return async (req, res, next) => {
    const pool = getPool();
    const key = keyFn(req);
    if (!key) return next();

    try {
      // Atomic upsert + increment
      await pool.query(
        `INSERT INTO rate_limit_buckets (id, count, window_start)
         VALUES (?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           count = IF(window_start < DATE_SUB(NOW(), INTERVAL ? MINUTE), 1, count + 1),
           window_start = IF(window_start < DATE_SUB(NOW(), INTERVAL ? MINUTE), NOW(), window_start),
           locked_until = IF(
             count + 1 > ? AND window_start >= DATE_SUB(NOW(), INTERVAL ? MINUTE),
             DATE_ADD(NOW(), INTERVAL ? MINUTE),
             locked_until
           )`,
        [key, windowMin, windowMin, max, windowMin, windowMin]
      );

      // Check if locked
      const [[bucket]] = await pool.query(
        'SELECT count, locked_until FROM rate_limit_buckets WHERE id = ?',
        [key]
      );

      if (bucket?.locked_until && new Date(bucket.locked_until) > new Date()) {
        const retryAfter = new Date(bucket.locked_until).toISOString();
        res.set('Retry-After', String(Math.ceil((new Date(bucket.locked_until) - Date.now()) / 1000)));
        log.info({ event: 'rate_limit.hit', key, count: bucket.count });
        return next(new RateLimitError(retryAfter));
      }

      if (bucket && bucket.count > max) {
        log.info({ event: 'rate_limit.exceeded', key, count: bucket.count });
        return next(new RateLimitError());
      }

      next();
    } catch (err) {
      log.error({ event: 'rate_limit.error', key, err: err.message });
      next(); // fail-open to avoid blocking on DB errors
    }
  };
}

// Preset configurations
const presets = {
  authLogin: { max: 5, windowMin: 5, keyFn: (req) => `auth_login:${req.ip}` },
  authRegister: { max: 3, windowMin: 60, keyFn: (req) => `auth_register:${req.ip}` },
  authForgot: { max: 3, windowMin: 60, keyFn: (req) => `auth_forgot:${req.ip}` },
  authForgotEmail: { max: 3, windowMin: 60, keyFn: (req) => `auth_forgot_email:${(req.body?.email || '').toLowerCase()}` },
  general: { max: 100, windowMin: 1, keyFn: (req) => `general:${req.user?.id || req.ip}` },
};

module.exports = { createRateLimit, presets };

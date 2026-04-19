'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { getPool } = require('../../config/db');
const { BCRYPT_COST, LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MIN } = require('../../config/constants');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth-service' });

// Precompute dummy hash at module load (timing defense — ATK-A06)
const DUMMY_HASH = bcrypt.hashSync('__dummy_not_real_password__', BCRYPT_COST);

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Authenticate user by email + password. Constant-time regardless of user existence.
 * @returns {Object|null} user row if authenticated, null otherwise
 */
async function authenticateUser(email, password) {
  const pool = getPool();
  const [[user]] = await pool.query(
    `SELECT id, email, password_hash, role, status, email_verified,
            failed_login_count, locked_until
     FROM users WHERE email = ?`,
    [email.toLowerCase().trim()]
  );

  // Always compare against a hash (dummy if user missing) — constant-time defense
  const hash = user?.password_hash ?? DUMMY_HASH;
  const match = await bcrypt.compare(password, hash);

  if (!user || !match) return null;
  if (user.status === 'banned') return null;
  return user;
}

/**
 * Check account lockout. Returns null if not locked, or { locked_until } if locked.
 */
async function checkLockout(email) {
  const pool = getPool();
  const [[user]] = await pool.query(
    'SELECT locked_until FROM users WHERE email = ?',
    [email.toLowerCase().trim()]
  );
  if (!user) return null; // no user = no lockout info (constant time via bcrypt)
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { locked_until: user.locked_until };
  }
  return null;
}

/**
 * Increment failed login count. Lock after LOGIN_MAX_ATTEMPTS.
 * Uses WHERE to prevent race condition allowing >5 attempts.
 */
async function recordFailedLogin(email) {
  const pool = getPool();
  // Increment + check atomically
  await pool.query(
    `UPDATE users SET
       failed_login_count = failed_login_count + 1,
       locked_until = IF(failed_login_count + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until)
     WHERE email = ?`,
    [LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MIN, email.toLowerCase().trim()]
  );
}

/**
 * Reset failed login count on successful login.
 */
async function recordSuccessfulLogin(userId, ip) {
  const pool = getPool();
  await pool.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL,
            last_login_at = NOW(), last_login_ip = ?
     WHERE id = ?`,
    [ip, userId]
  );
}

/**
 * Generate email verify token. Returns { raw, hashed }.
 * Raw sent to user via email. Hashed stored in DB.
 */
function generateEmailVerifyToken() {
  const raw = nanoid(32);
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

/**
 * Generate password reset token. Higher entropy than email verify (256 bits).
 */
function generatePasswordResetToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

/**
 * Hash a raw token for DB lookup comparison.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  hashPassword,
  authenticateUser,
  checkLockout,
  recordFailedLogin,
  recordSuccessfulLogin,
  generateEmailVerifyToken,
  generatePasswordResetToken,
  hashToken,
  DUMMY_HASH,
};

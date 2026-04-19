'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../config/db');
const { AuthError } = require('./errors');
const logger = require('./logger');
const { BCRYPT_COST } = require('../config/constants');

const log = logger.child({ module: 'jwt' });

/**
 * Issue short-lived access token (15 min default).
 * Payload: { sub: userId, role } — nothing else (no password, balance, email).
 * Algorithm pinned to HS256 (prevents alg:none forgery — ATK-A01).
 */
function issueAccess(user, config) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    config.JWT_ACCESS_SECRET,
    { algorithm: 'HS256', expiresIn: config.JWT_ACCESS_TTL || '15m' }
  );
}

/**
 * Verify access token. MUST pin algorithms: ['HS256'].
 * @returns {{ sub: number, role: string, iat: number, exp: number }}
 * @throws {AuthError}
 */
function verifyAccess(token, config) {
  try {
    return jwt.verify(token, config.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AuthError('Token expired', 'TOKEN_EXPIRED');
    }
    throw new AuthError('Invalid token', 'INVALID_TOKEN');
  }
}

/**
 * Issue refresh token: random 32 bytes, store bcrypt hash in user_sessions.
 * Returns { sessionId, rawToken, cookieValue } where cookieValue = "sessionId:rawToken".
 */
async function issueRefresh(userId, config, { ip, userAgent } = {}) {
  const pool = getPool();
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(rawToken, 10);

  const refreshTtlSec = parseTtlToSeconds(config.JWT_REFRESH_TTL || '30d');
  const expiresAt = new Date(Date.now() + refreshTtlSec * 1000);

  const [result] = await pool.query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, tokenHash, ip || null, (userAgent || '').slice(0, 500), expiresAt]
  );

  const sessionId = result.insertId;
  return {
    sessionId,
    rawToken,
    cookieValue: `${sessionId}:${rawToken}`,
    expiresAt,
  };
}

/**
 * Rotate refresh token. Revoke old, issue new.
 * CRITICAL: if old token was ALREADY revoked (reuse), revoke ALL sessions → compromise signal.
 */
async function rotateRefresh(cookieValue, config, { ip, userAgent } = {}) {
  const pool = getPool();

  const colonIdx = cookieValue.indexOf(':');
  if (colonIdx === -1) throw new AuthError('Invalid refresh token format', 'INVALID_TOKEN');

  const sessionId = parseInt(cookieValue.slice(0, colonIdx), 10);
  const rawToken = cookieValue.slice(colonIdx + 1);

  if (!sessionId || !rawToken) throw new AuthError('Invalid refresh token', 'INVALID_TOKEN');

  const [[session]] = await pool.query(
    'SELECT id, user_id, refresh_token_hash, revoked, expires_at FROM user_sessions WHERE id = ?',
    [sessionId]
  );

  if (!session) throw new AuthError('Session not found', 'INVALID_TOKEN');

  // Check if already revoked → REUSE DETECTED
  if (session.revoked) {
    log.warn({ event: 'jwt.refresh_reuse_detected', userId: session.user_id, sessionId });
    // Revoke ALL sessions for this user
    await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE user_id = ?', [session.user_id]);
    // Alert admin
    const { sendToAdmin } = require('./telegram');
    sendToAdmin(`⚠️ Refresh token reuse detected!\nUser ID: ${session.user_id}\nSession: ${sessionId}\nIP: ${ip || 'unknown'}`).catch(() => {});
    throw new AuthError('Session compromised — all sessions revoked', 'SESSION_COMPROMISED');
  }

  // Check expiry
  if (new Date(session.expires_at) < new Date()) {
    throw new AuthError('Refresh token expired', 'TOKEN_EXPIRED');
  }

  // Verify token hash
  const match = await bcrypt.compare(rawToken, session.refresh_token_hash);
  if (!match) throw new AuthError('Invalid refresh token', 'INVALID_TOKEN');

  // Revoke old session
  await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE id = ?', [sessionId]);

  // Issue new
  const newRefresh = await issueRefresh(session.user_id, config, { ip, userAgent });

  return { userId: session.user_id, ...newRefresh };
}

/**
 * Revoke a single session by sessionId.
 */
async function revokeSession(sessionId) {
  const pool = getPool();
  await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE id = ?', [sessionId]);
}

/**
 * Revoke all sessions for a user.
 */
async function revokeAllSessions(userId) {
  const pool = getPool();
  await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE user_id = ?', [userId]);
  log.info({ event: 'jwt.revoke_all_sessions', userId });
}

/**
 * Parse TTL strings like "15m", "30d", "1h" to seconds.
 */
function parseTtlToSeconds(ttl) {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 2592000; // default 30 days
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return val * (multipliers[unit] || 1);
}

module.exports = {
  issueAccess,
  verifyAccess,
  issueRefresh,
  rotateRefresh,
  revokeSession,
  revokeAllSessions,
  parseTtlToSeconds,
};

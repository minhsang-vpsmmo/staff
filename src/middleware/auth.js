'use strict';

const { verifyAccess } = require('../lib/jwt');
const { AuthError, ForbiddenError } = require('../lib/errors');
const { getPool } = require('../config/db');
const logger = require('../lib/logger');

const log = logger.child({ module: 'auth-middleware' });

/**
 * Require valid JWT access token. Attaches req.user = { id, role, email_verified }.
 * On expired: 401 TOKEN_EXPIRED (frontend knows to refresh).
 */
function requireAuth(config) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AuthError('Access token required', 'UNAUTHORIZED'));
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = verifyAccess(token, config);
    } catch (err) {
      return next(err);
    }

    // Lookup user status from DB
    const pool = getPool();
    const [[user]] = await pool.query(
      'SELECT id, email, role, status, email_verified FROM users WHERE id = ?',
      [payload.sub]
    );

    if (!user) {
      return next(new AuthError('User not found', 'INVALID_TOKEN'));
    }
    if (user.status === 'banned' || user.status === 'suspended') {
      return next(new ForbiddenError('Account suspended'));
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      email_verified: !!user.email_verified,
    };

    next();
  };
}

/**
 * Require admin or superadmin role.
 */
function requireAdmin(config) {
  const auth = requireAuth(config);
  return async (req, res, next) => {
    auth(req, res, (err) => {
      if (err) return next(err);
      if (!['admin', 'superadmin'].includes(req.user.role)) {
        return next(new ForbiddenError('Admin access required'));
      }
      next();
    });
  };
}

/**
 * Require verified email. Skips in dev mode with AUTO_VERIFY_EMAIL_IN_DEV=1.
 */
function requireEmailVerified(config) {
  const auth = requireAuth(config);
  return async (req, res, next) => {
    auth(req, res, (err) => {
      if (err) return next(err);
      if (!req.user.email_verified) {
        return next(new ForbiddenError('Email not verified'));
      }
      next();
    });
  };
}

module.exports = { requireAuth, requireAdmin, requireEmailVerified };

'use strict';

const { rotateRefresh, issueAccess } = require('../../lib/jwt');
const { getPool } = require('../../config/db');
const { AuthError } = require('../../lib/errors');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.refresh' });

/**
 * POST /api/auth/refresh
 * Reads refresh_token from httpOnly cookie. Rotates token. Returns new access_token.
 */
function refreshHandler(config) {
  return async (req, res, next) => {
    try {
      const cookieValue = req.cookies?.refresh_token;
      if (!cookieValue) {
        return next(new AuthError('Refresh token required', 'UNAUTHORIZED'));
      }

      const { userId, cookieValue: newCookieValue, expiresAt } = await rotateRefresh(cookieValue, config, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Lookup user for access token payload
      const pool = getPool();
      const [[user]] = await pool.query('SELECT id, role FROM users WHERE id = ?', [userId]);
      if (!user) {
        return next(new AuthError('User not found', 'INVALID_TOKEN'));
      }

      const accessToken = issueAccess(user, config);

      // Set new refresh cookie
      res.cookie('refresh_token', newCookieValue, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth',
        expires: expiresAt,
      });

      log.info({ event: 'auth.refresh.success', userId });

      res.json({ data: { access_token: accessToken } });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { refreshHandler };

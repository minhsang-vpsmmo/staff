'use strict';

const { revokeSession, revokeAllSessions } = require('../../lib/jwt');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.logout' });

/**
 * POST /api/auth/logout — Revoke current session.
 */
function logoutHandler(config) {
  return async (req, res, next) => {
    try {
      const cookieValue = req.cookies?.refresh_token;
      if (cookieValue) {
        const colonIdx = cookieValue.indexOf(':');
        if (colonIdx > 0) {
          const sessionId = parseInt(cookieValue.slice(0, colonIdx), 10);
          if (sessionId) await revokeSession(sessionId);
        }
      }

      // Clear cookie
      res.clearCookie('refresh_token', {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth',
      });

      log.info({ event: 'auth.logout', userId: req.user?.id });
      res.json({ data: { ok: true } });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * POST /api/me/logout-all — Revoke ALL sessions for current user.
 */
function logoutAllHandler(config) {
  return async (req, res, next) => {
    try {
      await revokeAllSessions(req.user.id);

      res.clearCookie('refresh_token', {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth',
      });

      log.info({ event: 'auth.logout_all', userId: req.user.id });
      res.json({ data: { ok: true, message: 'All sessions revoked' } });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { logoutHandler, logoutAllHandler };

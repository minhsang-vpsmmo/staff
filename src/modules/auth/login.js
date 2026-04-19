'use strict';

const { authenticateUser, checkLockout, recordFailedLogin, recordSuccessfulLogin } = require('./service');
const { loginSchema } = require('./validators');
const { issueAccess, issueRefresh } = require('../../lib/jwt');
const { RateLimitError, AuthError } = require('../../lib/errors');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.login' });

/**
 * POST /api/auth/login
 * Returns access_token in body, refresh_token in httpOnly cookie.
 */
function loginHandler(config) {
  return async (req, res, next) => {
    try {
      const { email, password } = loginSchema.parse(req.body);

      // Check lockout first (per-account, not per-IP)
      const lockout = await checkLockout(email);
      if (lockout) {
        // Return same shape as rate limit to prevent enumeration
        const retryAfter = new Date(lockout.locked_until).toISOString();
        res.set('Retry-After', String(Math.ceil((new Date(lockout.locked_until) - Date.now()) / 1000)));
        return next(new RateLimitError(retryAfter));
      }

      const user = await authenticateUser(email, password);

      if (!user) {
        // Record failed attempt (may trigger lockout)
        await recordFailedLogin(email);
        log.info({ event: 'auth.login.failed', email, ip: req.ip });
        return next(new AuthError('Invalid email or password', 'INVALID_CREDENTIALS'));
      }

      // Check email verified (production requires it)
      if (!user.email_verified && config.NODE_ENV === 'production') {
        return next(new AuthError('Email not verified', 'EMAIL_NOT_VERIFIED'));
      }

      // Success — reset failed count + issue tokens
      await recordSuccessfulLogin(user.id, req.ip);

      const accessToken = issueAccess(user, config);
      const refresh = await issueRefresh(user.id, config, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Set refresh token as httpOnly cookie
      res.cookie('refresh_token', refresh.cookieValue, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth',
        maxAge: (parseInt(config.JWT_REFRESH_TTL) || 30) * 24 * 60 * 60 * 1000,
      });

      log.info({ event: 'auth.login.success', userId: user.id, email });

      res.json({
        data: {
          access_token: accessToken,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            email_verified: !!user.email_verified,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { loginHandler };

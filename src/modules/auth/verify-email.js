'use strict';

const { getPool } = require('../../config/db');
const { hashToken } = require('./service');
const { AppError } = require('../../lib/errors');
const { EMAIL_VERIFY_TOKEN_TTL_HOURS } = require('../../config/constants');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.verify-email' });

/**
 * GET /api/auth/verify-email?token=X
 * Hash token, lookup, verify TTL (48h), mark verified.
 */
function verifyEmailHandler(config) {
  return async (req, res, next) => {
    try {
      const rawToken = req.query.token;
      if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 10) {
        throw new AppError('INVALID_TOKEN', 'Invalid or missing verification token', 400);
      }

      const tokenHash = hashToken(rawToken);
      const pool = getPool();

      const [[user]] = await pool.query(
        'SELECT id, email, email_verified, email_verify_token, created_at FROM users WHERE email_verify_token = ?',
        [tokenHash]
      );

      if (!user) {
        throw new AppError('INVALID_TOKEN', 'Token không hợp lệ hoặc đã được sử dụng', 400);
      }

      if (user.email_verified) {
        return res.json({ data: { message: 'Email đã được xác thực trước đó' } });
      }

      // Check TTL
      const tokenAge = (Date.now() - new Date(user.created_at).getTime()) / 3600000;
      if (tokenAge > EMAIL_VERIFY_TOKEN_TTL_HOURS) {
        throw new AppError('TOKEN_EXPIRED', 'Link xác thực đã hết hạn (48h). Đăng ký lại hoặc liên hệ hỗ trợ.', 400);
      }

      // Mark verified + clear token (single-use)
      await pool.query(
        'UPDATE users SET email_verified = TRUE, email_verify_token = NULL WHERE id = ?',
        [user.id]
      );

      log.info({ event: 'auth.email_verified', userId: user.id, email: user.email });

      res.json({ data: { message: 'Email xác thực thành công! Bạn có thể đăng nhập.' } });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { verifyEmailHandler };

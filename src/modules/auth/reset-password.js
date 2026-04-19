'use strict';

const { getPool } = require('../../config/db');
const { hashPassword, hashToken } = require('./service');
const { resetPasswordSchema } = require('./validators');
const { revokeAllSessions } = require('../../lib/jwt');
const { AppError } = require('../../lib/errors');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.reset-password' });

/**
 * POST /api/auth/reset-password { token, new_password }
 * Single-use token. Revokes all sessions. Does NOT auto-login.
 */
function resetPasswordHandler(config) {
  return async (req, res, next) => {
    try {
      const { token: rawToken, new_password } = resetPasswordSchema.parse(req.body);
      const tokenHash = hashToken(rawToken);

      const pool = getPool();
      const [[resetRow]] = await pool.query(
        `SELECT id, user_id, expires_at, used_at
         FROM password_reset_tokens
         WHERE token_hash = ?`,
        [tokenHash]
      );

      if (!resetRow) {
        throw new AppError('INVALID_TOKEN', 'Token không hợp lệ', 400);
      }
      if (resetRow.used_at) {
        throw new AppError('TOKEN_USED', 'Token đã được sử dụng', 400);
      }
      if (new Date(resetRow.expires_at) < new Date()) {
        throw new AppError('TOKEN_EXPIRED', 'Token đã hết hạn', 400);
      }

      const newHash = await hashPassword(new_password);

      // Update password + mark token used (in single connection for consistency)
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, resetRow.user_id]);
        await conn.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [resetRow.id]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      // Revoke ALL sessions (force re-login everywhere)
      await revokeAllSessions(resetRow.user_id);

      log.info({ event: 'auth.reset.success', userId: resetRow.user_id });

      // Do NOT auto-login
      res.json({ data: { message: 'Mật khẩu đã được đặt lại. Vui lòng đăng nhập lại.' } });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { resetPasswordHandler };

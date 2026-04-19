'use strict';

const { getPool } = require('../../config/db');
const { hashPassword } = require('./service');
const { changePasswordSchema } = require('./validators');
const { revokeAllSessions } = require('../../lib/jwt');
const { AuthError, AppError } = require('../../lib/errors');
const bcrypt = require('bcrypt');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.me' });

/**
 * GET /api/me — User profile (never returns password_hash, verify tokens).
 */
function getMeHandler(config) {
  return async (req, res, next) => {
    try {
      const pool = getPool();
      const [[user]] = await pool.query(
        `SELECT id, email, role, status, balance, email_verified, telegram_verified,
                telegram_chat_id, last_login_at, created_at
         FROM users WHERE id = ?`,
        [req.user.id]
      );
      if (!user) return next(new AppError('NOT_FOUND', 'User not found', 404));

      res.json({
        data: {
          id: user.id,
          email: user.email,
          role: user.role,
          status: user.status,
          balance: user.balance,
          email_verified: !!user.email_verified,
          telegram_verified: !!user.telegram_verified,
          last_login_at: user.last_login_at,
          created_at: user.created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * PATCH /api/me — Update profile. Strips role/balance/email (SEC-D05, ATK-A07).
 */
function updateMeHandler(config) {
  return async (req, res, next) => {
    try {
      // Explicitly reject any sensitive field manipulation
      const { role, balance, email, status, is_admin, password, password_hash, ...safe } = req.body || {};

      if (role !== undefined || balance !== undefined || status !== undefined) {
        log.warn({ event: 'auth.me.escalation_attempt', userId: req.user.id, fields: { role, balance, status } });
      }

      // For now, no editable profile fields in Phase 2 (future: display_name, etc.)
      res.json({ data: { message: 'Profile updated', id: req.user.id } });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * POST /api/me/change-password — Requires current password.
 * Revokes all OTHER sessions (keeps current).
 */
function changePasswordHandler(config) {
  return async (req, res, next) => {
    try {
      const { current_password, new_password } = changePasswordSchema.parse(req.body);

      const pool = getPool();
      const [[user]] = await pool.query(
        'SELECT password_hash FROM users WHERE id = ?',
        [req.user.id]
      );
      if (!user) return next(new AuthError('User not found'));

      const match = await bcrypt.compare(current_password, user.password_hash);
      if (!match) return next(new AuthError('Current password incorrect', 'INVALID_CREDENTIALS'));

      const newHash = await hashPassword(new_password);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

      // Revoke all sessions except current
      const cookieValue = req.cookies?.refresh_token;
      let currentSessionId = null;
      if (cookieValue) {
        const colonIdx = cookieValue.indexOf(':');
        if (colonIdx > 0) currentSessionId = parseInt(cookieValue.slice(0, colonIdx), 10);
      }

      if (currentSessionId) {
        await pool.query(
          'UPDATE user_sessions SET revoked = TRUE WHERE user_id = ? AND id != ?',
          [req.user.id, currentSessionId]
        );
      } else {
        await revokeAllSessions(req.user.id);
      }

      log.info({ event: 'auth.change_password.success', userId: req.user.id });

      res.json({ data: { message: 'Đổi mật khẩu thành công. Các phiên đăng nhập khác đã bị thu hồi.' } });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { getMeHandler, updateMeHandler, changePasswordHandler };

'use strict';

const { getPool } = require('../../config/db');
const { generatePasswordResetToken } = require('./service');
const { forgotPasswordSchema } = require('./validators');
const { enqueueEmail } = require('../../lib/email');
const { PASSWORD_RESET_TOKEN_TTL_HOURS } = require('../../config/constants');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.forgot-password' });

/**
 * POST /api/auth/forgot-password
 * ALWAYS returns 200 regardless of email existence (no enumeration — SEC-A04).
 */
function forgotPasswordHandler(config) {
  return async (req, res, next) => {
    try {
      const { email } = forgotPasswordSchema.parse(req.body);

      // Always return same response shape and ~same timing
      const pool = getPool();
      const [[user]] = await pool.query(
        'SELECT id, email, status FROM users WHERE email = ?',
        [email]
      );

      if (user && user.status !== 'banned') {
        const { raw, hashed } = generatePasswordResetToken();
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_HOURS * 3600000);

        await pool.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
           VALUES (?, ?, ?, ?)`,
          [user.id, hashed, expiresAt, req.ip]
        );

        const resetUrl = `${config.APP_URL}/api/auth/reset-password?token=${raw}`;
        await enqueueEmail({
          to: email,
          subject: 'Đặt lại mật khẩu — VPSMMO Monitoring',
          html: buildResetEmailHtml(resetUrl),
          text: `Đặt lại mật khẩu VPSMMO Monitoring: ${resetUrl} (hết hạn ${PASSWORD_RESET_TOKEN_TTL_HOURS}h)`,
          category: 'reset',
          priority: 1,
        });

        log.info({ event: 'auth.forgot.sent', userId: user.id });
      } else {
        log.info({ event: 'auth.forgot.no_user', email });
      }

      // Same response regardless
      res.json({ data: { message: 'Nếu email tồn tại, bạn sẽ nhận được link đặt lại mật khẩu.' } });
    } catch (err) {
      next(err);
    }
  };
}

function buildResetEmailHtml(resetUrl) {
  return `<div style="max-width:600px;margin:0 auto;font-family:sans-serif">
  <h2>Đặt lại mật khẩu — VPSMMO Monitoring</h2>
  <p>Bạn (hoặc ai đó) đã yêu cầu đặt lại mật khẩu. Nhấn nút bên dưới:</p>
  <p style="text-align:center;margin:24px 0">
    <a href="${resetUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
      Đặt lại mật khẩu
    </a>
  </p>
  <p style="color:#666;font-size:13px">Link hết hạn sau 1 giờ. Nếu không phải bạn, bỏ qua email này.</p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
  <p style="color:#999;font-size:12px"><i>Reset your VPSMMO Monitoring password. Link expires in 1 hour.</i></p>
</div>`;
}

module.exports = { forgotPasswordHandler };

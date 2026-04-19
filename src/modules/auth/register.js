'use strict';

const { getPool } = require('../../config/db');
const { hashPassword, generateEmailVerifyToken } = require('./service');
const { registerSchema, passwordStrength } = require('./validators');
const { enqueueEmail } = require('../../lib/email');
const { AppError } = require('../../lib/errors');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'auth.register' });

/**
 * POST /api/auth/register
 * Creates user with email_verified=false (or true if AUTO_VERIFY in dev).
 */
function registerHandler(config) {
  return async (req, res, next) => {
    try {
      const { email, password } = registerSchema.parse(req.body);

      const pool = getPool();

      // Check duplicate (case-insensitive)
      const [[existing]] = await pool.query(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
      if (existing) {
        throw new AppError('EMAIL_TAKEN', 'Email already registered', 400);
      }

      const passwordHash = await hashPassword(password);
      const { raw: verifyTokenRaw, hashed: verifyTokenHash } = generateEmailVerifyToken();

      // Adjustment 2: AUTO_VERIFY in dev mode
      const autoVerify = config.NODE_ENV !== 'production' && process.env.AUTO_VERIFY_EMAIL_IN_DEV === '1';
      const emailVerified = autoVerify;
      const storedToken = autoVerify ? null : verifyTokenHash;

      if (autoVerify) {
        log.warn({ event: 'auth.auto_verify_email', email });
      }

      const [result] = await pool.query(
        `INSERT INTO users (email, password_hash, email_verified, email_verify_token)
         VALUES (?, ?, ?, ?)`,
        [email, passwordHash, emailVerified, storedToken]
      );

      const userId = result.insertId;

      // Enqueue verification email (skip if auto-verified)
      if (!autoVerify) {
        const verifyUrl = `${config.APP_URL}/api/auth/verify-email?token=${verifyTokenRaw}`;
        await enqueueEmail({
          to: email,
          subject: 'Xác thực email — VPSMMO Monitoring',
          html: buildVerifyEmailHtml(verifyUrl),
          text: `Xác thực email VPSMMO Monitoring: ${verifyUrl} (hết hạn 48h)`,
          category: 'verify',
          priority: 1,
        });
      }

      log.info({ event: 'auth.register.success', userId, email, autoVerify });

      res.status(201).json({
        data: {
          message: autoVerify
            ? 'Tạo tài khoản thành công (email đã xác thực — dev mode)'
            : 'Tạo tài khoản thành công. Kiểm tra email để xác thực.',
          user_id: userId,
          password_strength: passwordStrength(password),
        },
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return next(new AppError('EMAIL_TAKEN', 'Email already registered', 400));
      }
      next(err);
    }
  };
}

function buildVerifyEmailHtml(verifyUrl) {
  return `<div style="max-width:600px;margin:0 auto;font-family:sans-serif">
  <h2>Xác thực email VPSMMO Monitoring</h2>
  <p>Chào mừng đến VPSMMO Monitoring! Nhấn nút để xác thực email:</p>
  <p style="text-align:center;margin:24px 0">
    <a href="${verifyUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
      Xác thực email
    </a>
  </p>
  <p style="color:#666;font-size:13px">Link hết hạn sau 48 giờ. Nếu không phải bạn, bỏ qua email này.</p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
  <p style="color:#999;font-size:12px"><i>Verify your VPSMMO Monitoring email. Click the button above. Link expires in 48h.</i></p>
</div>`;
}

module.exports = { registerHandler };

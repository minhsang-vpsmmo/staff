'use strict';

const Decimal = require('decimal.js');
const { credit, debit } = require('../wallet/service');
const { balanceAdjustSchema } = require('../wallet/validators');
const { format } = require('../../lib/money');
const { sendToAdmin } = require('../../lib/telegram');
const { AppError } = require('../../lib/errors');
const { ADMIN_ADJUST_ALERT_THRESHOLD_VND } = require('../../config/constants');
const { getPool } = require('../../config/db');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'admin.balance-adjust' });

/**
 * POST /api/admin/users/:id/balance-adjust
 * Body: { amount: "+50000" or "-30000", reason: "..." }
 */
function balanceAdjustHandler(config) {
  return async (req, res, next) => {
    try {
      const { amount: amountStr, reason } = balanceAdjustSchema.parse(req.body);

      // Validate target user ID
      const targetUserId = parseInt(req.params.id, 10);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new AppError('INVALID_USER_ID', 'Invalid user ID', 400);
      }

      // Pre-check user exists (with email for audit context)
      const pool = getPool();
      const [[targetUser]] = await pool.query(
        'SELECT id, email, status FROM users WHERE id = ?',
        [targetUserId]
      );
      if (!targetUser) {
        throw new AppError('TARGET_USER_NOT_FOUND', 'User ' + targetUserId + ' not found', 404);
      }

      const amountDec = new Decimal(amountStr);
      if (amountDec.isZero()) {
        throw new AppError('INVALID_AMOUNT', 'Amount cannot be zero', 400);
      }

      const isCredit = amountDec.gt(0);
      const absAmount = amountDec.abs().toFixed(2);
      const direction = isCredit ? 'credit' : 'debit';
      const idempotencyKey = 'admin:' + req.user.id + ':' + targetUserId + ':' + Date.now();

      const opts = {
        type: 'admin_adjust',
        refType: 'admin',
        refId: String(req.user.id),
        idempotencyKey,
        description: 'Admin adjust by ' + req.user.email + ': ' + reason,
        adminId: req.user.id,
        adminReason: reason,
        adminIp: req.ip,
      };

      let result;
      if (isCredit) {
        result = await credit(targetUserId, absAmount, opts);
      } else {
        result = await debit(targetUserId, absAmount, opts);
      }

      log.info({
        event: 'admin.balance_adjust',
        admin_id: req.user.id,
        admin_email: req.user.email,
        target_user_id: targetUserId,
        target_user_email: targetUser.email,
        target_user_status: targetUser.status,
        amount: amountDec.toFixed(2),
        direction,
        reason,
        balance_after: result.balanceAfter,
        transaction_id: result.transactionId,
        ip: req.ip,
      });

      if (amountDec.abs().gte(ADMIN_ADJUST_ALERT_THRESHOLD_VND)) {
        sendToAdmin(
          '🔔 <b>Admin Balance Adjust</b>\n' +
          'Admin: ' + req.user.email + ' (ID ' + req.user.id + ')\n' +
          'Target: ' + targetUser.email + ' (ID ' + targetUserId + ')\n' +
          'Amount: ' + amountDec.toFixed(2) + ' VND (' + direction + ')\n' +
          'Reason: ' + reason + '\n' +
          'Balance after: ' + result.balanceAfter + ' VND\n' +
          'IP: ' + req.ip
        ).catch(() => {});
      }

      res.json({
        data: {
          transaction_id: result.transactionId,
          balance_after: result.balanceAfter,
          formatted: format(new Decimal(result.balanceAfter)),
          direction,
          duplicate: result.duplicate || false,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { balanceAdjustHandler };

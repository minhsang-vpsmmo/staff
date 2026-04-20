'use strict';

const Decimal = require('decimal.js');
const { credit, debit } = require('../wallet/service');
const { balanceAdjustSchema } = require('../wallet/validators');
const { toVND, format } = require('../../lib/money');
const { sendToAdmin } = require('../../lib/telegram');
const { AppError } = require('../../lib/errors');
const { ADMIN_ADJUST_ALERT_THRESHOLD_VND } = require('../../config/constants');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'admin.balance-adjust' });

/**
 * POST /api/admin/users/:id/balance-adjust
 * Body: { amount: "+50000" or "-30000", reason: "..." }
 * amount positive = credit, negative = debit.
 * Routes through wallet.credit() or wallet.debit() with type='admin_adjust'.
 * Admin audit log written in same transaction (inside credit/debit).
 */
function balanceAdjustHandler(config) {
  return async (req, res, next) => {
    try {
      const { amount: amountStr, reason } = balanceAdjustSchema.parse(req.body);
      const targetUserId = parseInt(req.params.id, 10);
      if (!targetUserId || targetUserId <= 0) {
        throw new AppError('INVALID_ID', 'Invalid user ID', 400);
      }

      const amountDec = new Decimal(amountStr);
      if (amountDec.isZero()) {
        throw new AppError('INVALID_AMOUNT', 'Amount cannot be zero', 400);
      }

      const isCredit = amountDec.gt(0);
      const absAmount = amountDec.abs().toFixed(2);
      const direction = isCredit ? 'credit' : 'debit';
      const idempotencyKey = `admin:${req.user.id}:${targetUserId}:${Date.now()}`;

      const opts = {
        type: 'admin_adjust',
        refType: 'admin',
        refId: String(req.user.id),
        idempotencyKey,
        description: `Admin adjust by ${req.user.email}: ${reason}`,
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

      // Log with full context
      log.info({
        event: 'admin.balance_adjust',
        admin_id: req.user.id,
        admin_email: req.user.email,
        target_user_id: targetUserId,
        amount: amountDec.toFixed(2),
        direction,
        reason,
        balance_after: result.balanceAfter,
        transaction_id: result.transactionId,
        ip: req.ip,
      });

      // Telegram alert for large adjustments
      if (amountDec.abs().gte(ADMIN_ADJUST_ALERT_THRESHOLD_VND)) {
        sendToAdmin(
          `🔔 <b>Admin Balance Adjust</b>\n` +
          `Admin: ${req.user.email} (ID ${req.user.id})\n` +
          `Target: user ${targetUserId}\n` +
          `Amount: ${amountDec.toFixed(2)} VND (${direction})\n` +
          `Reason: ${reason}\n` +
          `Balance after: ${result.balanceAfter} VND\n` +
          `IP: ${req.ip}`
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

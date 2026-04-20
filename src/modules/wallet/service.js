'use strict';

const Decimal = require('decimal.js');
const { getPool } = require('../../config/db');
const { AppError, InsufficientBalanceError } = require('../../lib/errors');
const { toVND, fromVND, format } = require('../../lib/money');
const { ADMIN_REASON_MIN_LENGTH, PAGINATION_DEFAULT, PAGINATION_MAX } = require('../../config/constants');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'wallet' });

/**
 * Credit user wallet. Atomic with row lock + idempotency.
 * Writes wallet_transactions row BEFORE updating users.balance.
 *
 * Pre-conditions:
 *   - amount must be positive (string or Decimal, NOT JS Number)
 *   - opts.type required
 *   - opts.idempotencyKey required
 *   - if type='admin_adjust': opts.adminId + opts.adminReason required (min 10 chars)
 *
 * Post-conditions:
 *   - wallet_transactions row inserted with correct balance_before/after
 *   - users.balance updated to balanceAfter
 *   - if admin_adjust: admin_audit_log row inserted in same transaction
 *   - SUM(wallet_transactions.amount) === users.balance (invariant preserved)
 *
 * @param {number} userId
 * @param {string|Decimal} amount — VND, must be positive
 * @param {Object} opts
 * @param {'topup'|'purchase'|'renewal'|'refund'|'bonus'|'admin_adjust'} opts.type
 * @param {string} [opts.refType]
 * @param {string} [opts.refId]
 * @param {string} opts.idempotencyKey
 * @param {string} [opts.description]
 * @param {number} [opts.adminId]
 * @param {string} [opts.adminReason]
 * @param {string} [opts.adminIp]
 * @returns {Promise<{duplicate: boolean, transactionId: number, balanceAfter: string}>}
 */
async function credit(userId, amount, opts) {
  const amountDec = toVND(amount);
  if (amountDec.lte(0)) {
    throw new AppError('INVALID_AMOUNT', 'Amount must be positive', 400);
  }
  if (!opts?.type) {
    throw new AppError('MISSING_PARAMS', 'type is required', 400);
  }
  if (!opts?.idempotencyKey) {
    throw new AppError('MISSING_PARAMS', 'idempotencyKey is required', 400);
  }
  if (opts.type === 'admin_adjust') {
    if (!opts.adminId) throw new AppError('MISSING_PARAMS', 'adminId required for admin_adjust', 400);
    if (!opts.adminReason || opts.adminReason.length < ADMIN_REASON_MIN_LENGTH) {
      throw new AppError('INVALID_REASON', `admin_reason must be at least ${ADMIN_REASON_MIN_LENGTH} characters`, 400);
    }
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Step 1: Idempotency check FIRST
    const [[existing]] = await conn.query(
      'SELECT id, balance_after FROM wallet_transactions WHERE idempotency_key = ? LIMIT 1',
      [opts.idempotencyKey]
    );
    if (existing) {
      await conn.commit();
      return { duplicate: true, transactionId: existing.id, balanceAfter: existing.balance_after };
    }

    // Step 2: Lock user row
    const [[user]] = await conn.query(
      'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (!user) {
      await conn.rollback();
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Step 3: Compute new balance
    const balanceBefore = new Decimal(user.balance);
    const balanceAfter = balanceBefore.plus(amountDec);

    // Step 4: Write transaction row FIRST (audit before state change)
    const [txnResult] = await conn.query(
      `INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after,
         ref_type, ref_id, idempotency_key, description, admin_id, admin_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, opts.type, amountDec.toFixed(2),
        balanceBefore.toFixed(2), balanceAfter.toFixed(2),
        opts.refType || null, opts.refId || null,
        opts.idempotencyKey, opts.description || null,
        opts.adminId || null, opts.adminReason || null,
      ]
    );

    // Step 5: Update balance
    await conn.query(
      'UPDATE users SET balance = ? WHERE id = ?',
      [balanceAfter.toFixed(2), userId]
    );

    // Admin audit log (in same transaction)
    if (opts.type === 'admin_adjust') {
      await conn.query(
        `INSERT INTO admin_audit_log
          (admin_id, action, target_type, target_id, reason, metadata, ip_address)
         VALUES (?, 'balance_adjust', 'user', ?, ?, JSON_OBJECT('amount', ?, 'transaction_id', ?), ?)`,
        [
          opts.adminId, userId, opts.adminReason,
          amountDec.toFixed(2), txnResult.insertId,
          opts.adminIp || null,
        ]
      );
    }

    await conn.commit();

    log.info({
      event: 'wallet.credit.success',
      userId, amount: amountDec.toFixed(2), type: opts.type,
      transactionId: txnResult.insertId, balanceAfter: balanceAfter.toFixed(2),
    });

    return {
      duplicate: false,
      transactionId: txnResult.insertId,
      balanceAfter: balanceAfter.toFixed(2),
    };
  } catch (err) {
    await conn.rollback();
    log.error({ event: 'wallet.credit.failed', userId, amount: String(amount), err: err.message });
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Debit user wallet. Same atomic pattern as credit().
 * Additional: balance must be >= amount BEFORE INSERT (no negative balance).
 *
 * Amount stored as NEGATIVE in wallet_transactions.
 *
 * @throws {InsufficientBalanceError} if balance < amount
 */
async function debit(userId, amount, opts) {
  const amountDec = toVND(amount);
  if (amountDec.lte(0)) {
    throw new AppError('INVALID_AMOUNT', 'Amount must be positive', 400);
  }
  if (!opts?.type) {
    throw new AppError('MISSING_PARAMS', 'type is required', 400);
  }
  if (!opts?.idempotencyKey) {
    throw new AppError('MISSING_PARAMS', 'idempotencyKey is required', 400);
  }
  if (opts.type === 'admin_adjust') {
    if (!opts.adminId) throw new AppError('MISSING_PARAMS', 'adminId required for admin_adjust', 400);
    if (!opts.adminReason || opts.adminReason.length < ADMIN_REASON_MIN_LENGTH) {
      throw new AppError('INVALID_REASON', `admin_reason must be at least ${ADMIN_REASON_MIN_LENGTH} characters`, 400);
    }
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Step 1: Idempotency check
    const [[existing]] = await conn.query(
      'SELECT id, balance_after FROM wallet_transactions WHERE idempotency_key = ? LIMIT 1',
      [opts.idempotencyKey]
    );
    if (existing) {
      await conn.commit();
      return { duplicate: true, transactionId: existing.id, balanceAfter: existing.balance_after };
    }

    // Step 2: Lock user row
    const [[user]] = await conn.query(
      'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (!user) {
      await conn.rollback();
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Step 3: Check sufficient balance BEFORE any write
    const balanceBefore = new Decimal(user.balance);
    if (balanceBefore.lt(amountDec)) {
      await conn.rollback();
      log.info({
        event: 'wallet.debit.insufficient', userId,
        required: amountDec.toFixed(2), available: balanceBefore.toFixed(2),
      });
      throw new InsufficientBalanceError({
        required: amountDec.toFixed(2),
        available: balanceBefore.toFixed(2),
      });
    }

    const balanceAfter = balanceBefore.minus(amountDec);
    const negativeAmount = amountDec.negated();

    // Step 4: Transaction row FIRST
    const [txnResult] = await conn.query(
      `INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after,
         ref_type, ref_id, idempotency_key, description, admin_id, admin_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, opts.type, negativeAmount.toFixed(2),
        balanceBefore.toFixed(2), balanceAfter.toFixed(2),
        opts.refType || null, opts.refId || null,
        opts.idempotencyKey, opts.description || null,
        opts.adminId || null, opts.adminReason || null,
      ]
    );

    // Step 5: Update balance
    await conn.query(
      'UPDATE users SET balance = ? WHERE id = ?',
      [balanceAfter.toFixed(2), userId]
    );

    // Admin audit log
    if (opts.type === 'admin_adjust') {
      await conn.query(
        `INSERT INTO admin_audit_log
          (admin_id, action, target_type, target_id, reason, metadata, ip_address)
         VALUES (?, 'balance_adjust', 'user', ?, ?, JSON_OBJECT('amount', ?, 'transaction_id', ?), ?)`,
        [
          opts.adminId, userId, opts.adminReason,
          negativeAmount.toFixed(2), txnResult.insertId,
          opts.adminIp || null,
        ]
      );
    }

    await conn.commit();

    log.info({
      event: 'wallet.debit.success',
      userId, amount: amountDec.toFixed(2), type: opts.type,
      transactionId: txnResult.insertId, balanceAfter: balanceAfter.toFixed(2),
    });

    return {
      duplicate: false,
      transactionId: txnResult.insertId,
      balanceAfter: balanceAfter.toFixed(2),
    };
  } catch (err) {
    if (!(err instanceof InsufficientBalanceError)) {
      await conn.rollback();
      log.error({ event: 'wallet.debit.failed', userId, amount: String(amount), err: err.message });
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Get user's current balance.
 * @param {number} userId
 * @returns {Promise<{balance: string, formatted: string}>}
 */
async function getBalance(userId) {
  const pool = getPool();
  const [[user]] = await pool.query(
    'SELECT balance FROM users WHERE id = ?',
    [userId]
  );
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);

  const balance = new Decimal(user.balance);
  return {
    balance: balance.toFixed(2),
    formatted: format(balance),
  };
}

/**
 * Get paginated transaction history. Ownership: WHERE user_id = userId.
 * @param {number} userId
 * @param {Object} filters
 * @returns {Promise<{data: Array, meta: {page, per_page, total}}>}
 */
async function getTransactions(userId, filters = {}) {
  const pool = getPool();
  const page = Math.max(1, parseInt(filters.page) || 1);
  const perPage = Math.min(PAGINATION_MAX, Math.max(1, parseInt(filters.perPage) || PAGINATION_DEFAULT));
  const offset = (page - 1) * perPage;

  let where = 'WHERE user_id = ?';
  const params = [userId];

  if (filters.type) {
    where += ' AND type = ?';
    params.push(filters.type);
  }
  if (filters.from) {
    where += ' AND created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    where += ' AND created_at <= ?';
    params.push(filters.to);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM wallet_transactions ${where}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT id, type, amount, balance_before, balance_after,
            ref_type, ref_id, description, created_at
     FROM wallet_transactions ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );

  return {
    data: rows,
    meta: { page, per_page: perPage, total },
  };
}

module.exports = { credit, debit, getBalance, getTransactions };

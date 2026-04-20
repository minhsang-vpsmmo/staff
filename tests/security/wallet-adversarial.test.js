'use strict';

const Decimal = require('decimal.js');
const { execSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'vpsmmo_monitoring';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'vpsmmo_monitoring';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b'.repeat(32);
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test';
process.env.TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '12345';

const { getPool, createPool } = require('../../src/config/db');

// Initialize pool for standalone test
const { validateEnv } = require("../../src/config/env");
const config = validateEnv();
createPool(config);
const { credit, debit } = require('../../src/modules/wallet/service');

let testUserId;

beforeAll(async () => {
  const pool = getPool();
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('AdvWallet1!', 12);
  const email = `adv_wallet_${Date.now()}@test.com`;
  const [result] = await pool.query(
    "INSERT INTO users (email, password_hash, balance, email_verified) VALUES (?, ?, '0.00', TRUE)",
    [email, hash]
  );
  testUserId = result.insertId;
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM wallet_transactions WHERE user_id = ?', [testUserId]);
  await pool.query('DELETE FROM users WHERE id = ?', [testUserId]);

  // INVARIANT CHECK
  const [[{ broken }]] = await pool.query(`
    SELECT COUNT(*) AS broken FROM (
      SELECT u.id, u.balance FROM users u LEFT JOIN wallet_transactions wt ON u.id = wt.user_id
      GROUP BY u.id HAVING u.balance != COALESCE(SUM(wt.amount), 0)
    ) t
  `);
  expect(broken).toBe(0);
});

describe('Wallet adversarial tests', () => {
  it('ATK-M01: credit with negative amount → INVALID_AMOUNT', async () => {
    await expect(
      credit(testUserId, '-50000', { type: 'topup', idempotencyKey: `atk-m01:${Date.now()}` })
    ).rejects.toThrow("Amount must be positive");
  });

  it('ATK-M01b: debit with negative amount → INVALID_AMOUNT', async () => {
    await expect(
      debit(testUserId, '-50000', { type: 'purchase', idempotencyKey: `atk-m01b:${Date.now()}` })
    ).rejects.toThrow("Amount must be positive");
  });

  it('ATK-M02: 50 parallel credits with SAME idempotencyKey → exactly 1 succeeds', async () => {
    const pool = getPool();
    const [[before]] = await pool.query('SELECT balance FROM users WHERE id = ?', [testUserId]);
    const initialBalance = new Decimal(before.balance);
    const key = `atk-m02:${Date.now()}`;

    const results = await Promise.allSettled(
      Array(50).fill(0).map(() =>
        credit(testUserId, '10000', { type: 'topup', idempotencyKey: key, refType: 'test' })
      )
    );

    const successes = results.filter(r => r.status === 'fulfilled' && !r.value.duplicate);
    const duplicates = results.filter(r => r.status === 'fulfilled' && r.value.duplicate);
    const errors = results.filter(r => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(duplicates.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);

    const [[user]] = await pool.query('SELECT balance FROM users WHERE id = ?', [testUserId]);
    expect(new Decimal(user.balance).toFixed(2)).toBe(initialBalance.plus('10000').toFixed(2));

    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM wallet_transactions WHERE idempotency_key = ?', [key]
    );
    expect(cnt).toBe(1);
  }, 30000);

  it('ATK-M03/M11: wallet_transactions has NO UPDATE paths in src/', () => {
    let result;
    try {
      result = execSync('grep -rn "UPDATE wallet_transactions" src/ || true', { encoding: 'utf8' });
    } catch {
      result = '';
    }

    const actualMatches = result.split('\n')
      .filter(line => line.trim())
      .filter(line => !line.includes('//'))
      .filter(line => !line.startsWith('tests/'));

    expect(actualMatches).toHaveLength(0);
  });

  it('ATK-M12: 100x credit 99.99 → exactly 9999.00 (Decimal precision)', async () => {
    // Reset balance
    const pool = getPool();
    await pool.query('DELETE FROM wallet_transactions WHERE user_id = ?', [testUserId]);
    await pool.query('UPDATE users SET balance = 0 WHERE id = ?', [testUserId]);

    // 100 sequential credits of 99.99
    for (let i = 0; i < 100; i++) {
      await credit(testUserId, '99.99', {
        type: 'bonus',
        idempotencyKey: `atk-m12:${Date.now()}:${i}`,
      });
    }

    const [[user]] = await pool.query('SELECT balance FROM users WHERE id = ?', [testUserId]);
    expect(new Decimal(user.balance).toFixed(2)).toBe('9999.00');

    const [[{ total }]] = await pool.query(
      'SELECT SUM(amount) AS total FROM wallet_transactions WHERE user_id = ? AND idempotency_key LIKE ?',
      [testUserId, 'atk-m12:%']
    );
    expect(new Decimal(total).toFixed(2)).toBe('9999.00');
  }, 60000);

  it('ATK-M10: admin adjust without reason → rejected', async () => {
    await expect(
      credit(testUserId, '1000', {
        type: 'admin_adjust',
        idempotencyKey: `atk-m10:${Date.now()}`,
        adminId: 1,
        adminReason: 'short',
      })
    ).rejects.toThrow("admin_reason must be at least");
  });

  it('credit with zero amount → INVALID_AMOUNT', async () => {
    await expect(
      credit(testUserId, '0', { type: 'topup', idempotencyKey: `zero:${Date.now()}` })
    ).rejects.toThrow("Amount must be positive");
  });

  it('credit without idempotencyKey → MISSING_PARAMS', async () => {
    await expect(
      credit(testUserId, '1000', { type: 'topup' })
    ).rejects.toThrow("idempotencyKey is required");
  });
});

'use strict';

const Decimal = require('decimal.js');

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
  const hash = await bcrypt.hash('ConcurrentTest1!', 12);
  const email = `concurrent_${Date.now()}@test.com`;
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

beforeEach(async () => {
  // Reset balance to 0 for each test
  const pool = getPool();
  await pool.query('DELETE FROM wallet_transactions WHERE user_id = ?', [testUserId]);
  await pool.query('UPDATE users SET balance = 0 WHERE id = ?', [testUserId]);
});

describe('Wallet concurrent tests', () => {
  it('10 parallel credits +10000 each → final balance = 100000', async () => {
    const results = await Promise.allSettled(
      Array(10).fill(0).map((_, i) =>
        credit(testUserId, '10000', {
          type: 'topup',
          idempotencyKey: `concurrent:credit:${Date.now()}:${i}`,
          refType: 'test',
        })
      )
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(0);

    // Verify DB
    const pool = getPool();
    const [[user]] = await pool.query('SELECT balance FROM users WHERE id = ?', [testUserId]);
    expect(new Decimal(user.balance).toFixed(2)).toBe('100000.00');

    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM wallet_transactions WHERE user_id = ?', [testUserId]
    );
    expect(cnt).toBe(10);

    const [[{ total }]] = await pool.query(
      'SELECT SUM(amount) AS total FROM wallet_transactions WHERE user_id = ?', [testUserId]
    );
    expect(new Decimal(total).toFixed(2)).toBe('100000.00');
  }, 30000);

  it('5 parallel debits 50000 from balance 50000 → exactly 1 succeeds', async () => {
    // Seed balance
    await credit(testUserId, '50000', {
      type: 'topup', idempotencyKey: `concurrent:seed:${Date.now()}`,
    });

    const results = await Promise.allSettled(
      Array(5).fill(0).map((_, i) =>
        debit(testUserId, '50000', {
          type: 'purchase',
          idempotencyKey: `concurrent:debit:${Date.now()}:${i}`,
        })
      )
    );

    const successes = results.filter(r => r.status === 'fulfilled' && !r.value.duplicate);
    const insufficients = results.filter(r =>
      r.status === 'rejected' && r.reason?.code === 'INSUFFICIENT_BALANCE'
    );

    expect(successes).toHaveLength(1);
    expect(insufficients).toHaveLength(4);

    // Balance must be 0, never negative
    const pool = getPool();
    const [[user]] = await pool.query('SELECT balance FROM users WHERE id = ?', [testUserId]);
    expect(new Decimal(user.balance).gte(0)).toBe(true);
    expect(new Decimal(user.balance).toFixed(2)).toBe('0.00');
  }, 30000);

  it('10 parallel identical idempotency keys → exactly 1 txn row', async () => {
    const key = `concurrent:idem:${Date.now()}`;
    const results = await Promise.allSettled(
      Array(10).fill(0).map(() =>
        credit(testUserId, '5000', {
          type: 'topup', idempotencyKey: key,
        })
      )
    );

    const successes = results.filter(r => r.status === 'fulfilled' && !r.value.duplicate);
    const duplicates = results.filter(r => r.status === 'fulfilled' && r.value.duplicate);
    const errors = results.filter(r => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(duplicates.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);

    // DB: exactly 1 row
    const pool = getPool();
    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM wallet_transactions WHERE idempotency_key = ?', [key]
    );
    expect(cnt).toBe(1);
  }, 30000);
});

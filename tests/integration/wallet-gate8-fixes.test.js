'use strict';

const Decimal = require('decimal.js');
const request = require('supertest');

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
process.env.AUTO_VERIFY_EMAIL_IN_DEV = '1';
process.env.APP_URL = 'http://localhost:3099';
process.env.PAY2S_BANK_ACCOUNTS = '12805521';

const { app } = require('../../src/server');
const { getPool } = require('../../src/config/db');
const { credit, debit, getTransactions } = require('../../src/modules/wallet/service');

let testUserId, adminUserId, adminToken;

beforeAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM rate_limit_buckets');
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('Gate8Fix1!', 12);

  const userEmail = 'gate8_user_' + Date.now() + '@test.com';
  const [u] = await pool.query("INSERT INTO users (email, password_hash, email_verified, balance) VALUES (?, ?, TRUE, '0.00')", [userEmail, hash]);
  testUserId = u.insertId;

  const adminEmail = 'gate8_admin_' + Date.now() + '@test.com';
  const [a] = await pool.query("INSERT INTO users (email, password_hash, role, email_verified, balance) VALUES (?, ?, 'admin', TRUE, '0.00')", [adminEmail, hash]);
  adminUserId = a.insertId;
  await pool.query('DELETE FROM rate_limit_buckets');
  const login = await request(app).post('/api/auth/login').send({ email: adminEmail, password: 'Gate8Fix1!' });
  adminToken = login.body.data?.access_token;
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM admin_audit_log WHERE admin_id = ?', [adminUserId]);
  await pool.query('DELETE FROM wallet_transactions WHERE user_id IN (?, ?)', [testUserId, adminUserId]);
  await pool.query('DELETE FROM user_sessions WHERE user_id IN (?, ?)', [testUserId, adminUserId]);
  await pool.query('DELETE FROM rate_limit_buckets');
  await pool.query('DELETE FROM users WHERE id IN (?, ?)', [testUserId, adminUserId]);
});

describe('Fix 1: Date range boundary', () => {
  it('to filter includes entire day (not just midnight)', async () => {
    const pool = getPool();
    const ts = Date.now();
    const k = (n) => 'g8d-' + ts + '-' + n;

    // Insert at different times on Dec 31
    await pool.query('INSERT INTO wallet_transactions (user_id,type,amount,balance_before,balance_after,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)',
      [testUserId, 'topup', '1000.00', '0.00', '1000.00', k(1), '2026-12-31 00:00:01']);
    await pool.query('INSERT INTO wallet_transactions (user_id,type,amount,balance_before,balance_after,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)',
      [testUserId, 'topup', '2000.00', '0.00', '2000.00', k(2), '2026-12-31 12:00:00']);
    await pool.query('INSERT INTO wallet_transactions (user_id,type,amount,balance_before,balance_after,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)',
      [testUserId, 'topup', '3000.00', '0.00', '3000.00', k(3), '2026-12-31 23:59:59']);
    // Jan 1 — must NOT be included
    await pool.query('INSERT INTO wallet_transactions (user_id,type,amount,balance_before,balance_after,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)',
      [testUserId, 'topup', '4000.00', '0.00', '4000.00', k(4), '2027-01-01 00:00:00']);

    const result = await getTransactions(testUserId, { from: '2026-12-31', to: '2026-12-31', perPage: 100 });

    // Service returns created_at. Filter by date to verify boundary.
    const dec31 = result.data.filter(t => {
      const ca = String(t.created_at);
      return ca.includes('2026-12-31') || ca.includes('Dec 31');
    });
    const jan1 = result.data.filter(t => {
      const ca = String(t.created_at);
      return ca.includes('2027-01-01') || ca.includes('Jan 01');
    });

    expect(dec31.length).toBeGreaterThanOrEqual(3);
    expect(jan1.length).toBe(0);

    // Cleanup
    for (let i = 1; i <= 4; i++) {
      await pool.query('DELETE FROM wallet_transactions WHERE idempotency_key = ?', [k(i)]);
    }
  });
});

describe('Fix 2: MIN_AMOUNT_VND dust rejection', () => {
  it('credit 500 VND (below min 1000) rejects', async () => {
    await expect(
      credit(testUserId, '500', { type: 'topup', idempotencyKey: 'dust-1-' + Date.now() })
    ).rejects.toThrow('Amount must be at least');
  });

  it('credit 999 VND rejects', async () => {
    await expect(
      credit(testUserId, '999', { type: 'topup', idempotencyKey: 'dust-2-' + Date.now() })
    ).rejects.toThrow('Amount must be at least');
  });

  it('credit 1000 VND (exactly min) accepts', async () => {
    const result = await credit(testUserId, '1000', { type: 'topup', idempotencyKey: 'dust-3-' + Date.now() });
    expect(result.duplicate).toBe(false);
  });

  it('debit 500 VND (below min) rejects', async () => {
    await expect(
      debit(testUserId, '500', { type: 'purchase', idempotencyKey: 'dust-4-' + Date.now() })
    ).rejects.toThrow('Amount must be at least');
  });

  it('admin_adjust 100 VND accepts (bypass min)', async () => {
    await credit(testUserId, '10000', { type: 'topup', idempotencyKey: 'dust-seed-' + Date.now() });
    const result = await credit(testUserId, '100', {
      type: 'admin_adjust', idempotencyKey: 'dust-admin-' + Date.now(),
      adminId: adminUserId, adminReason: 'Fix rounding error for test user account balance',
    });
    expect(result.duplicate).toBe(false);
  });
});

describe('Fix 3: Admin target user validation', () => {
  it('string user ID returns 400', async () => {
    const res = await request(app)
      .post('/api/admin/users/abc/balance-adjust')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: '1000', reason: 'Testing invalid string user ID param' });
    expect(res.status).toBe(400);
  });

  it('negative user ID returns 400', async () => {
    const res = await request(app)
      .post('/api/admin/users/-1/balance-adjust')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: '1000', reason: 'Testing negative user ID parameter' });
    expect(res.status).toBe(400);
  });

  it('non-existent user ID returns 404', async () => {
    const res = await request(app)
      .post('/api/admin/users/999999/balance-adjust')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: '1000', reason: 'Testing non-existent user ID target' });
    expect(res.status).toBe(404);
  });
});

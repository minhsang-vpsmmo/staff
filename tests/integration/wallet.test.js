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
const { credit, debit, getBalance, getTransactions } = require('../../src/modules/wallet/service');

let testUserId;
let testAdminId;
let userToken;
let adminToken;

beforeAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM rate_limit_buckets');

  // Create test user
  let res = await request(app).post('/api/auth/register')
    .send({ email: `wallet_user_${Date.now()}@test.com`, password: 'WalletP@ss1!' });
  testUserId = res.body.data.user_id;
  await pool.query('DELETE FROM rate_limit_buckets');
  res = await request(app).post('/api/auth/login')
    .send({ email: `wallet_user_${Date.now() - 1}@test.com`, password: 'WalletP@ss1!' });

  // Get token via direct login approach
  const email = `wt_${Date.now()}@test.com`;
  await request(app).post('/api/auth/register').send({ email, password: 'WalletP@ss1!' });
  await pool.query('DELETE FROM rate_limit_buckets');
  const login = await request(app).post('/api/auth/login').send({ email, password: 'WalletP@ss1!' });
  userToken = login.body.data?.access_token;
  testUserId = login.body.data?.user?.id;

  // Create admin user directly in DB
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('AdminP@ss1!', 12);
  const adminEmail = `admin_${Date.now()}@test.com`;
  const [adminResult] = await pool.query(
    "INSERT INTO users (email, password_hash, role, email_verified) VALUES (?, ?, 'admin', TRUE)",
    [adminEmail, hash]
  );
  testAdminId = adminResult.insertId;
  await pool.query('DELETE FROM rate_limit_buckets');
  const adminLogin = await request(app).post('/api/auth/login').send({ email: adminEmail, password: 'AdminP@ss1!' });
  adminToken = adminLogin.body.data?.access_token;
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM admin_audit_log WHERE admin_id = ?', [testAdminId]);
  await pool.query('DELETE FROM wallet_transactions WHERE user_id IN (?, ?)', [testUserId, testAdminId]);
  await pool.query('DELETE FROM user_sessions WHERE user_id IN (?, ?)', [testUserId, testAdminId]);
  await pool.query('DELETE FROM email_queue WHERE to_email LIKE ?', ['%@test.com']);
  await pool.query('DELETE FROM rate_limit_buckets');
  await pool.query('DELETE FROM users WHERE id IN (?, ?)', [testUserId, testAdminId]);

  // INVARIANT CHECK
  const [[{ broken }]] = await pool.query(`
    SELECT COUNT(*) AS broken FROM (
      SELECT u.id, u.balance FROM users u LEFT JOIN wallet_transactions wt ON u.id = wt.user_id
      GROUP BY u.id HAVING u.balance != COALESCE(SUM(wt.amount), 0)
    ) t
  `);
  expect(broken).toBe(0);
});

describe('Wallet service', () => {
  it('credit() creates txn row + updates balance', async () => {
    const result = await credit(testUserId, '50000', {
      type: 'topup', idempotencyKey: `test:credit:${Date.now()}`,
      refType: 'test', description: 'Test credit',
    });
    expect(result.duplicate).toBe(false);
    expect(result.transactionId).toBeGreaterThan(0);
    expect(result.balanceAfter).toBe('50000.00');

    const bal = await getBalance(testUserId);
    expect(bal.balance).toBe('50000.00');
  });

  it('credit() balance_before + amount = balance_after', async () => {
    const pool = getPool();
    const key = `test:verify:${Date.now()}`;
    await credit(testUserId, '25000', { type: 'bonus', idempotencyKey: key });

    const [[txn]] = await pool.query(
      'SELECT amount, balance_before, balance_after FROM wallet_transactions WHERE idempotency_key = ?',
      [key]
    );
    const before = new Decimal(txn.balance_before);
    const amount = new Decimal(txn.amount);
    const after = new Decimal(txn.balance_after);
    expect(before.plus(amount).toFixed(2)).toBe(after.toFixed(2));
  });

  it('credit() idempotency: same key → duplicate=true, no double credit', async () => {
    const key = `test:idem:${Date.now()}`;
    const r1 = await credit(testUserId, '10000', { type: 'topup', idempotencyKey: key });
    const r2 = await credit(testUserId, '10000', { type: 'topup', idempotencyKey: key });
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r1.transactionId).toBe(r2.transactionId);
  });

  it('debit() reduces balance, stores negative amount', async () => {
    const before = await getBalance(testUserId);
    const result = await debit(testUserId, '10000', {
      type: 'purchase', idempotencyKey: `test:debit:${Date.now()}`,
    });
    expect(result.duplicate).toBe(false);
    const after = await getBalance(testUserId);
    expect(new Decimal(after.balance).toFixed(2))
      .toBe(new Decimal(before.balance).minus('10000').toFixed(2));
  });

  it('debit() insufficient → InsufficientBalanceError, no state change', async () => {
    const before = await getBalance(testUserId);
    await expect(
      debit(testUserId, '99999999', { type: 'purchase', idempotencyKey: `test:insuff:${Date.now()}` })
    ).rejects.toThrow('Số dư không đủ');
    const after = await getBalance(testUserId);
    expect(after.balance).toBe(before.balance);
  });

  it('credit() with negative amount → INVALID_AMOUNT', async () => {
    await expect(
      credit(testUserId, '-50000', { type: 'topup', idempotencyKey: `test:neg:${Date.now()}` })
    ).rejects.toThrow("Amount must be positive");
  });

  it('credit() with zero amount → INVALID_AMOUNT', async () => {
    await expect(
      credit(testUserId, '0', { type: 'topup', idempotencyKey: `test:zero:${Date.now()}` })
    ).rejects.toThrow("Amount must be positive");
  });

  it('credit() with JS Number → TypeError', async () => {
    await expect(
      credit(testUserId, 50000, { type: 'topup', idempotencyKey: `test:num:${Date.now()}` })
    ).rejects.toThrow(TypeError);
  });

  it('getTransactions() returns only own data', async () => {
    const result = await getTransactions(testUserId, {});
    expect(result.data.length).toBeGreaterThan(0);
    result.data.forEach(txn => {
      expect(txn.user_id).toBeUndefined(); // not in SELECT columns for security
    });
    expect(result.meta.page).toBe(1);
  });
});

describe('Wallet HTTP endpoints', () => {
  it('GET /api/wallet/balance — authenticated', async () => {
    const res = await request(app).get('/api/wallet/balance')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBeDefined();
    expect(res.body.data.formatted).toContain('₫');
  });

  it('GET /api/wallet/balance — no auth → 401', async () => {
    const res = await request(app).get('/api/wallet/balance');
    expect(res.status).toBe(401);
  });

  it('GET /api/wallet/topup-info — returns QR + memo', async () => {
    const res = await request(app).get('/api/wallet/topup-info')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.memo).toContain('VPSMMO');
    expect(res.body.data.bank_accounts.length).toBeGreaterThan(0);
  });
});

describe('Admin balance-adjust', () => {
  it('positive adjust → credit + audit log', async () => {
    const pool = getPool();
    const res = await request(app)
      .post(`/api/admin/users/${testUserId}/balance-adjust`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: '100000', reason: 'Hoàn tiền lỗi hệ thống order #test123' });
    expect(res.status).toBe(200);
    expect(res.body.data.direction).toBe('credit');
    expect(res.body.data.transaction_id).toBeGreaterThan(0);

    const [[audit]] = await pool.query(
      'SELECT action, reason FROM admin_audit_log WHERE admin_id = ? ORDER BY id DESC LIMIT 1',
      [testAdminId]
    );
    expect(audit.action).toBe('balance_adjust');
    expect(audit.reason).toContain('order #test123');
  });

  it('negative adjust → debit + audit log', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${testUserId}/balance-adjust`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: '-10000', reason: 'Thu hồi số dư phát sinh sai lệch' });
    expect(res.status).toBe(200);
    expect(res.body.data.direction).toBe('debit');
  });

  it('short reason → 400', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${testUserId}/balance-adjust`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: '1000', reason: 'short' });
    expect(res.status).toBe(400);
  });

  it('non-admin → 403', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${testUserId}/balance-adjust`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: '1000', reason: 'Test unauthorized access attempt' });
    expect(res.status).toBe(403);
  });
});

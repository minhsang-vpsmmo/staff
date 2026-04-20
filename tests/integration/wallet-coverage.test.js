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
process.env.PAY2S_BANK_ACCOUNTS = '12805521,999999999';

const { app } = require('../../src/server');
const { getPool } = require('../../src/config/db');
const { credit, debit, getBalance, getTransactions } = require('../../src/modules/wallet/service');
const { generateTopupInfo, buildQrUrl } = require('../../src/lib/vietqr');

let testUserId, adminUserId, userToken, adminToken;

beforeAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM rate_limit_buckets');
  const bcrypt = require('bcrypt');

  // Create user
  const userEmail = 'cov_user_' + Date.now() + '@test.com';
  const hash = await bcrypt.hash('CovTestP@ss1!', 12);
  const [u] = await pool.query("INSERT INTO users (email, password_hash, email_verified, balance) VALUES (?, ?, TRUE, '0.00')", [userEmail, hash]);
  testUserId = u.insertId;
  await pool.query('DELETE FROM rate_limit_buckets');
  const login = await request(app).post('/api/auth/login').send({ email: userEmail, password: 'CovTestP@ss1!' });
  userToken = login.body.data?.access_token;

  // Create admin
  const adminEmail = 'cov_admin_' + Date.now() + '@test.com';
  const [a] = await pool.query("INSERT INTO users (email, password_hash, role, email_verified, balance) VALUES (?, ?, 'admin', TRUE, '0.00')", [adminEmail, hash]);
  adminUserId = a.insertId;
  await pool.query('DELETE FROM rate_limit_buckets');
  const adminLogin = await request(app).post('/api/auth/login').send({ email: adminEmail, password: 'CovTestP@ss1!' });
  adminToken = adminLogin.body.data?.access_token;
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM admin_audit_log WHERE admin_id = ?', [adminUserId]);
  await pool.query('DELETE FROM wallet_transactions WHERE user_id IN (?, ?)', [testUserId, adminUserId]);
  await pool.query('DELETE FROM user_sessions WHERE user_id IN (?, ?)', [testUserId, adminUserId]);
  await pool.query('DELETE FROM rate_limit_buckets');
  await pool.query('DELETE FROM users WHERE id IN (?, ?)', [testUserId, adminUserId]);
});

describe('Wallet coverage — debit edge cases', () => {
  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM wallet_transactions WHERE user_id = ?', [testUserId]);
    await pool.query("UPDATE users SET balance = '100000.00' WHERE id = ?", [testUserId]);
  });

  it('debit() with admin_adjust type + audit log', async () => {
    const pool = getPool();
    const result = await debit(testUserId, '5000', {
      type: 'admin_adjust',
      idempotencyKey: 'cov:admin_debit:' + Date.now(),
      adminId: adminUserId,
      adminReason: 'Coverage test for admin debit path with audit log',
      adminIp: '127.0.0.1',
    });
    expect(result.duplicate).toBe(false);

    const [[audit]] = await pool.query(
      'SELECT action, reason FROM admin_audit_log WHERE admin_id = ? ORDER BY id DESC LIMIT 1',
      [adminUserId]
    );
    expect(audit.action).toBe('balance_adjust');
  });

  it('debit() idempotency: same key twice → duplicate', async () => {
    const key = 'cov:debit_idem:' + Date.now();
    const r1 = await debit(testUserId, '1000', { type: 'purchase', idempotencyKey: key });
    const r2 = await debit(testUserId, '1000', { type: 'purchase', idempotencyKey: key });
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
  });

  it('debit() without type → MISSING_PARAMS', async () => {
    await expect(debit(testUserId, '1000', { idempotencyKey: 'x' }))
      .rejects.toThrow('type is required');
  });

  it('debit() without idempotencyKey → MISSING_PARAMS', async () => {
    await expect(debit(testUserId, '1000', { type: 'purchase' }))
      .rejects.toThrow('idempotencyKey is required');
  });

  it('debit() admin_adjust without adminId → MISSING_PARAMS', async () => {
    await expect(debit(testUserId, '1000', {
      type: 'admin_adjust', idempotencyKey: 'x',
      adminReason: 'This is a valid reason text',
    })).rejects.toThrow('adminId required');
  });

  it('debit() admin_adjust with short reason → INVALID_REASON', async () => {
    await expect(debit(testUserId, '1000', {
      type: 'admin_adjust', idempotencyKey: 'x',
      adminId: 1, adminReason: 'short',
    })).rejects.toThrow('admin_reason must be at least');
  });

  it('debit() user not found → USER_NOT_FOUND', async () => {
    await expect(debit(999999, '1000', {
      type: 'purchase', idempotencyKey: 'cov:notfound:' + Date.now(),
    })).rejects.toThrow('User not found');
  });

  it('credit() without type → MISSING_PARAMS', async () => {
    await expect(credit(testUserId, '1000', { idempotencyKey: 'x' }))
      .rejects.toThrow('type is required');
  });

  it('credit() admin_adjust without adminId → MISSING_PARAMS', async () => {
    await expect(credit(testUserId, '1000', {
      type: 'admin_adjust', idempotencyKey: 'x',
      adminReason: 'Valid reason over ten chars',
    })).rejects.toThrow('adminId required');
  });

  it('credit() admin_adjust with short reason → INVALID_REASON', async () => {
    await expect(credit(testUserId, '1000', {
      type: 'admin_adjust', idempotencyKey: 'x',
      adminId: 1, adminReason: 'short',
    })).rejects.toThrow('admin_reason must be at least');
  });

  it('credit() user not found → USER_NOT_FOUND', async () => {
    await expect(credit(999999, '1000', {
      type: 'topup', idempotencyKey: 'cov:credit_notfound:' + Date.now(),
    })).rejects.toThrow('User not found');
  });
});

describe('Wallet coverage — HTTP routes', () => {
  it('GET /api/wallet/transactions — with filters', async () => {
    // Seed a transaction first
    await credit(testUserId, '5000', {
      type: 'bonus', idempotencyKey: 'cov:txn_filter:' + Date.now(),
    });

    const res = await request(app)
      .get('/api/wallet/transactions?type=bonus&page=1&per_page=5')
      .set('Authorization', 'Bearer ' + userToken);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.page).toBe(1);
  });

  it('GET /api/wallet/transactions — with date filters', async () => {
    const res = await request(app)
      .get('/api/wallet/transactions?from=2020-01-01&to=2030-12-31')
      .set('Authorization', 'Bearer ' + userToken);
    expect(res.status).toBe(200);
  });
});

describe('Wallet coverage — admin balance-adjust edge cases', () => {
  it('admin adjust zero amount → 400', async () => {
    const res = await request(app)
      .post('/api/admin/users/' + testUserId + '/balance-adjust')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: '0', reason: 'Testing zero amount rejection in coverage' });
    expect(res.status).toBe(400);
  });

  it('admin adjust invalid user ID → 400', async () => {
    const res = await request(app)
      .post('/api/admin/users/0/balance-adjust')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: '1000', reason: 'Testing invalid ID zero coverage' });
    expect(res.status).toBe(400);
  });

  it('admin adjust large amount (>500k) → triggers telegram (no crash)', async () => {
    // Seed balance first
    await credit(testUserId, '1000000', {
      type: 'topup', idempotencyKey: 'cov:seed_large:' + Date.now(),
    });

    const res = await request(app)
      .post('/api/admin/users/' + testUserId + '/balance-adjust')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: '-600000', reason: 'Coverage test large debit triggers telegram alert notification' });
    expect(res.status).toBe(200);
    expect(res.body.data.direction).toBe('debit');
  });
});

describe('VietQR coverage — unknown bank', () => {
  it('unknown account number defaults to ACB bank code', () => {
    const info = generateTopupInfo(1, { PAY2S_BANK_ACCOUNTS: '999999999' });
    expect(info.bank_accounts[0].bank).toBe('ACB');
    expect(info.bank_accounts[0].qr_url).toContain('ACB-999999999');
  });
});

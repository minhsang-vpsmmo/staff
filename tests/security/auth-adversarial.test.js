'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'vpsmmo_monitoring';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'vpsmmo_monitoring';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b'.repeat(32);
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '12345';
process.env.AUTO_VERIFY_EMAIL_IN_DEV = '1';
process.env.APP_URL = 'http://localhost:3099';

const { app } = require('../../src/server');
const { getPool } = require('../../src/config/db');

const ADV_EMAIL = `adv_${Date.now()}@test.com`;
const ADV_PASS = 'AdvTestP@ss99!';

async function resetRateLimits() {
  const pool = getPool();
  await pool.query('DELETE FROM rate_limit_buckets');
}

async function resetLockout() {
  const pool = getPool();
  await pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = ?', [ADV_EMAIL]);
}

async function safeLogin() {
  await resetRateLimits();
  await resetLockout();
  const res = await request(app).post('/api/auth/login').send({ email: ADV_EMAIL, password: ADV_PASS });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookies = res.headers['set-cookie'] || [];
  const rtCookie = cookies.find(c => c.startsWith('refresh_token='));
  const cookieValue = rtCookie ? rtCookie.split(';')[0].replace('refresh_token=', '') : null;
  return { token: res.body.data.access_token, cookie: cookieValue };
}

describe('Auth adversarial tests', () => {
  beforeAll(async () => {
    await resetRateLimits();
    await request(app).post('/api/auth/register').send({ email: ADV_EMAIL, password: ADV_PASS });
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)', [ADV_EMAIL]);
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)', [ADV_EMAIL]);
    await pool.query('DELETE FROM email_queue WHERE to_email = ?', [ADV_EMAIL]);
    await pool.query('DELETE FROM rate_limit_buckets');
    await pool.query('DELETE FROM users WHERE email = ?', [ADV_EMAIL]);
  });

  it('ATK-A01: JWT alg:none forgery → 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 1, role: 'superadmin', iat: Math.floor(Date.now()/1000), exp: 9999999999 })).toString('base64url');
    const forged = `${header}.${payload}.`;

    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('ATK-A01b: JWT wrong algorithm → 401', async () => {
    const token = jwt.sign({ sub: 1, role: 'superadmin' }, 'any-key', { algorithm: 'HS384' });
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('ATK-A04: refresh token reuse → revoke all sessions', async () => {
    const { cookie: cookie1 } = await safeLogin();
    expect(cookie1).toBeTruthy();

    // First refresh — works
    const ref1 = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${cookie1}`);
    expect(ref1.status).toBe(200);

    // Second refresh with SAME old cookie — compromised
    const ref2 = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${cookie1}`);
    expect(ref2.status).toBe(401);
    expect(ref2.body.error.code).toBe('SESSION_COMPROMISED');
  });

  it('ATK-A05: 5 wrong logins → lockout (correct password blocked too)', async () => {
    await resetLockout();
    await resetRateLimits();

    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ email: ADV_EMAIL, password: `wrong${i}` });
    }

    // 6th with CORRECT password → still locked
    const res = await request(app).post('/api/auth/login').send({ email: ADV_EMAIL, password: ADV_PASS });
    expect(res.status).toBe(429);

    await resetLockout();
  });

  it('ATK-A07: role escalation via PATCH /api/me → role unchanged', async () => {
    const { token } = await safeLogin();

    await request(app).patch('/api/me').set('Authorization', `Bearer ${token}`)
      .send({ role: 'superadmin', balance: '99999999.00', status: 'admin' });

    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.data.role).toBe('user');
    expect(me.body.data.status).toBe('active');
  });

  it('ATK-A08: password reset token reuse → second fails', async () => {
    const pool = getPool();
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const [[user]] = await pool.query('SELECT id FROM users WHERE email = ?', [ADV_EMAIL]);

    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), ?)',
      [user.id, hashedToken, '127.0.0.1']
    );

    // First use — success
    const res1 = await request(app).post('/api/auth/reset-password')
      .send({ token: rawToken, new_password: 'NewStrongP@ss1!' });
    expect(res1.status).toBe(200);

    // Second use — fail
    const res2 = await request(app).post('/api/auth/reset-password')
      .send({ token: rawToken, new_password: 'AnotherP@ss2!' });
    expect(res2.status).toBe(400);
    expect(res2.body.error.code).toBe('TOKEN_USED');

    // Restore password
    const hash = await bcrypt.hash(ADV_PASS, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
  });


  it('ATK-A06: login timing existing vs nonexistent user diff < 15%', async () => {
    const pool = getPool();
    const EXISTING = 'timing_exists_' + Date.now() + '@test.com';
    const NONEXISTENT = 'timing_nonexist_' + Date.now() + '@test.com';

    await pool.query('DELETE FROM rate_limit_buckets');
    await request(app).post('/api/auth/register')
      .send({ email: EXISTING, password: 'ValidP@ss123' });
    await pool.query('DELETE FROM rate_limit_buckets');

    const N = 30;
    const times = { existing: [], nonexistent: [] };

    for (let i = 0; i < N; i++) {
      await pool.query('DELETE FROM rate_limit_buckets');
      await pool.query('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE email = ?', [EXISTING]);

      const start1 = Date.now();
      await request(app).post('/api/auth/login')
        .send({ email: EXISTING, password: 'WrongP@ss' });
      times.existing.push(Date.now() - start1);

      await pool.query('DELETE FROM rate_limit_buckets');

      const start2 = Date.now();
      await request(app).post('/api/auth/login')
        .send({ email: NONEXISTENT, password: 'AnyP@ss' });
      times.nonexistent.push(Date.now() - start2);
    }

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const avgExisting = avg(times.existing);
    const avgNonexistent = avg(times.nonexistent);
    const diff = Math.abs(avgExisting - avgNonexistent);
    const pct = diff / Math.max(avgExisting, avgNonexistent);

    console.log('Timing: existing=' + avgExisting.toFixed(1) + 'ms, nonexistent=' + avgNonexistent.toFixed(1) + 'ms, diff=' + (pct * 100).toFixed(1) + '%');

    expect(pct).toBeLessThan(0.15);

    // Cleanup
    await pool.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)', [EXISTING]);
    await pool.query('DELETE FROM email_queue WHERE to_email = ?', [EXISTING]);
    await pool.query('DELETE FROM users WHERE email = ?', [EXISTING]);
    await pool.query('DELETE FROM rate_limit_buckets');
  }, 120000);

});

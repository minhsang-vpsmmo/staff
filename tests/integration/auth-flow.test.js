'use strict';

const request = require('supertest');

// Set test env
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

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM rate_limit_buckets");
});

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM rate_limit_buckets");
});

const TEST_EMAIL = `authtest_${Date.now()}@test.com`;
const TEST_PASSWORD = 'StrongP@ss123!';
let accessToken = null;
let refreshCookie = null;

describe('Auth flow integration', () => {
  afterAll(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)', [TEST_EMAIL]);
    await pool.query('DELETE FROM email_queue WHERE to_email = ?', [TEST_EMAIL]);
    await pool.query('DELETE FROM users WHERE email = ?', [TEST_EMAIL]);
  });

  it('POST /api/auth/register — creates user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.data.user_id).toBeGreaterThan(0);
    expect(res.body.data.password_strength).toBeDefined();
  });

  it('POST /api/auth/register — duplicate email → 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('POST /api/auth/register — weak password → 400', async () => {
    await getPool().query('DELETE FROM rate_limit_buckets');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'weak@test.com', password: '1234' });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/register — common password → 400', async () => {
    await getPool().query('DELETE FROM rate_limit_buckets');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'common@test.com', password: 'password1' });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login — success', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();
    expect(res.body.data.user.email).toBe(TEST_EMAIL);
    expect(res.body.data.user.role).toBe('user');

    accessToken = res.body.data.access_token;
    // Extract Set-Cookie
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const rtCookie = cookies.find(c => c.startsWith('refresh_token='));
    expect(rtCookie).toBeDefined();
    expect(rtCookie).toContain('HttpOnly');
    refreshCookie = rtCookie.split(';')[0].split('=').slice(1).join('=');
  });

  it('POST /api/auth/login — wrong password → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'WrongPassword123!' });
    expect(res.status).toBe(401);
  });

  it('GET /api/me — authenticated', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(TEST_EMAIL);
    // Must NOT contain password_hash
    expect(res.body.data.password_hash).toBeUndefined();
    expect(res.body.data.password).toBeUndefined();
  });

  it('GET /api/me — no token → 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/refresh — rotates token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${refreshCookie}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();
    // New cookie set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
  });

  it('POST /api/auth/forgot-password — always 200', async () => {
    const res1 = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: TEST_EMAIL });
    expect(res1.status).toBe(200);

    // Non-existent email — same response
    const res2 = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nonexistent@test.com' });
    expect(res2.status).toBe(200);
  });

  it('POST /api/auth/logout — revokes session', async () => {
    // Login fresh
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const token = login.body.data.access_token;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', `refresh_token=${login.headers['set-cookie'][0].split(';')[0].split('=').slice(1).join('=')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
  });

  it('PATCH /api/me — role escalation attempt ignored (ATK-A07)', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const token = login.body.data.access_token;

    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'superadmin', balance: 9999999 });
    expect(res.status).toBe(200);

    // Verify role NOT changed
    const me = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.body.data.role).toBe('user');
  });
});

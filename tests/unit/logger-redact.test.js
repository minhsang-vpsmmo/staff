'use strict';

const pino = require('pino');

// Create a test logger with same redaction config as production
const redactPaths = [
  'password', 'password_hash',
  'token', 'authorization', 'access_token', 'refresh_token', 'refreshToken',
  'secret', 'cookie', 'creditCard',
  'pay2s_webhook_secret', 'PAY2S_WEBHOOK_SECRET', 'PAY2S_API_TOKEN',
  'smtp_app_password', 'SMTP_APP_PASSWORD',
  'req.headers.authorization', 'req.headers.cookie',
  'res.headers["set-cookie"]',
];

function createTestLogger() {
  const lines = [];
  const dest = {
    write(line) { lines.push(JSON.parse(line)); },
  };
  const logger = pino({
    level: 'info',
    redact: { paths: redactPaths, censor: '[REDACTED]' },
  }, dest);
  return { logger, lines };
}

describe('logger redaction', () => {
  it('redacts top-level password field', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ password: 'my-secret-pass' }, 'test');
    expect(lines[0].password).toBe('[REDACTED]');
  });

  it('redacts nested req.headers.authorization', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ req: { headers: { authorization: 'Bearer eyJhbGc...' } } }, 'test');
    expect(lines[0].req.headers.authorization).toBe('[REDACTED]');
  });

  it('redacts Pay2S-specific paths', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ pay2s_webhook_secret: 'secret123' }, 'test pay2s');
    expect(lines[0].pay2s_webhook_secret).toBe('[REDACTED]');
  });

  it('redacts PAY2S_API_TOKEN', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ PAY2S_API_TOKEN: 'token-value' }, 'test');
    expect(lines[0].PAY2S_API_TOKEN).toBe('[REDACTED]');
  });

  it('redacts smtp_app_password', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ smtp_app_password: 'app-pass' }, 'test');
    expect(lines[0].smtp_app_password).toBe('[REDACTED]');
  });

  it('does NOT redact normal fields', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ username: 'normal_user', email: 'test@test.com' }, 'test');
    expect(lines[0].username).toBe('normal_user');
    expect(lines[0].email).toBe('test@test.com');
  });

  it('redacts password_hash', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ password_hash: '$2b$12$abcdef...' }, 'test');
    expect(lines[0].password_hash).toBe('[REDACTED]');
  });

  it('redacts cookie field', () => {
    const { logger, lines } = createTestLogger();
    logger.info({ cookie: 'session=abc123' }, 'test');
    expect(lines[0].cookie).toBe('[REDACTED]');
  });
});

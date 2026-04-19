'use strict';

const { execSync } = require('child_process');
const path = require('path');

const serverPath = path.join(__dirname, '..', '..', 'src', 'server.js');

function runWithEnv(envOverrides = {}) {
  const env = {
    NODE_ENV: 'test',
    PORT: '3099',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_ADMIN_CHAT_ID: '12345',
    ...envOverrides,
  };

  try {
    const output = execSync(`node -e "require('${serverPath}')"`, {
      env,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

describe('Environment validation', () => {
  it('exits with code 1 when DB_PASSWORD missing', () => {
    const result = runWithEnv({ DB_PASSWORD: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('DB_PASSWORD');
  });

  it('exits with code 1 when JWT_ACCESS_SECRET too short', () => {
    const result = runWithEnv({ JWT_ACCESS_SECRET: 'short' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('JWT_ACCESS_SECRET');
  });

  it('exits with code 1 when JWT secrets are identical', () => {
    const same = 'x'.repeat(32);
    const result = runWithEnv({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('different');
  });

  it('exits with code 1 when TELEGRAM_BOT_TOKEN missing', () => {
    const result = runWithEnv({ TELEGRAM_BOT_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('TELEGRAM_BOT_TOKEN');
  });
});

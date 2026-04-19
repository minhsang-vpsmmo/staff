'use strict';

const { z } = require('zod');

// Load .env BEFORE validation
require('dotenv').config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().optional().default('http://localhost:3000'),

  // Database — always required
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),

  // JWT — always required, min 32 chars
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Telegram — always required
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_ADMIN_CHAT_ID: z.string().min(1, 'TELEGRAM_ADMIN_CHAT_ID is required'),

  // Pay2S — required in production only
  PAY2S_WEBHOOK_SECRET: z.string().optional().default(''),
  PAY2S_API_TOKEN: z.string().optional().default(''),
  PAY2S_BANK_ACCOUNTS: z.string().optional().default(''),
  PAY2S_ALLOWED_IPS: z.string().optional().default(''),

  // Email — required in production only
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_APP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().default('no-reply@vpsmmo.vn'),

  // Ops
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ADMIN_ALERT_TELEGRAM: z.string().optional().default(''),
  ALLOW_PROD_MIGRATE: z.string().optional().default(''),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const missing = Object.entries(errors)
      .map(([key, msgs]) => `  ${key}: ${msgs.join(', ')}`)
      .join('\n');
    process.stderr.write(`\n❌ Environment validation failed:\n${missing}\n\n`);
    process.stderr.write('Copy .env.example to .env and fill required values.\n\n');
    process.exit(1);
  }

  const config = result.data;

  // JWT secrets must differ
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    process.stderr.write('\n❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.\n\n');
    process.exit(1);
  }

  // Production-only checks
  if (config.NODE_ENV === 'production') {
    const prodRequired = {
      PAY2S_WEBHOOK_SECRET: config.PAY2S_WEBHOOK_SECRET,
      PAY2S_API_TOKEN: config.PAY2S_API_TOKEN,
      SMTP_USER: config.SMTP_USER,
      SMTP_APP_PASSWORD: config.SMTP_APP_PASSWORD,
    };
    const missing = Object.entries(prodRequired)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      process.stderr.write(`\n❌ Production requires: ${missing.join(', ')}\n\n`);
      process.exit(1);
    }
  }

  return Object.freeze(config);
}

module.exports = { validateEnv };

'use strict';

const pino = require('pino');
const path = require('path');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';

const redactPaths = [
  'password',
  'password_hash',
  'token',
  'authorization',
  'access_token',
  'refresh_token',
  'refreshToken',
  'secret',
  'cookie',
  'creditCard',
  'pay2s_webhook_secret',
  'PAY2S_WEBHOOK_SECRET',
  'PAY2S_API_TOKEN',
  'smtp_app_password',
  'SMTP_APP_PASSWORD',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

let transport;

if (NODE_ENV === 'test') {
  // Silent in tests
  transport = undefined;
} else if (NODE_ENV === 'development') {
  transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  };
} else {
  // Production: JSON to file
  const logFile = path.join('/var/log/vpsmmo-monitoring', 'app.log');
  transport = {
    target: 'pino/file',
    options: { destination: logFile, mkdir: true },
  };
}

const logger = pino({
  name: 'vpsmmo-monitoring',
  level: NODE_ENV === 'test' ? 'silent' : LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  ...(transport ? { transport } : {}),
});

module.exports = logger;

'use strict';

const { validateEnv } = require('./config/env');
const config = validateEnv();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const logger = require('./lib/logger');
const { createPool, ping, closePool } = require('./config/db');
const { init: initTelegram } = require('./lib/telegram');
const { errorHandler } = require('./middleware/error-handler');
const { createAuthRoutes } = require('./modules/auth/routes');
const { createWalletRoutes } = require("./modules/wallet/routes");
const { createAdminRoutes } = require("./modules/admin/routes");

const log = logger.child({ module: 'server' });
const app = express();

// ── Security middleware ──
app.use(helmet({
  contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: config.NODE_ENV === 'production' ? config.APP_URL : true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ── Trust proxy (behind Nginx) ──
app.set('trust proxy', 1);

// ── Database ──
createPool(config);

// ── Telegram ──
initTelegram(config);

// ── Health check ──
app.get('/health', async (req, res) => {
  const dbOk = await ping();
  res.json({
    status: 'ok',
    uptime_sec: Math.floor(process.uptime()),
    db: dbOk ? 'ok' : 'fail',
    email_queue_pending: 0,
    webhook_pending: 0,
    version: '1.0.0',
  });
});

// ── Root ──
app.get('/', (req, res) => {
  res.json({
    name: 'VPSMMO Monitoring API',
    version: '1.0.0',
    docs: 'https://monitoring.vpsmmo.vn',
  });
});

// ── API routes ──
app.use('/api', createAuthRoutes(config));
app.use("/api", createWalletRoutes(config));
app.use("/api", createAdminRoutes(config));

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// ── Error handler ──
app.use(errorHandler);

// ── Start server ──
const PORT = config.PORT;
let server;

function start() {
  return new Promise((resolve) => {
    server = app.listen(PORT, '0.0.0.0', () => {
      log.info({ event: 'server.started', port: PORT, env: config.NODE_ENV });
      resolve(server);
    });
  });
}

// ── Graceful shutdown ──
async function shutdown(signal) {
  log.info({ event: 'server.shutdown', signal });
  if (server) {
    server.close(() => {
      log.info({ event: 'server.closed' });
    });
  }
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log.error({ event: 'unhandled_rejection', err: err?.message, stack: err?.stack });
});
process.on('uncaughtException', (err) => {
  log.error({ event: 'uncaught_exception', err: err.message, stack: err.stack });
  process.exit(1);
});

if (require.main === module) {
  start().catch((err) => {
    log.error({ event: 'server.start_failed', err: err.message });
    process.exit(1);
  });
}

module.exports = { app, start, shutdown };

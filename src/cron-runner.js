'use strict';

/**
 * Cron runner — PM2 process "vpsmmo-monitoring-cron".
 * Runs scheduled jobs. Separate from web process for fault isolation.
 *
 * Jobs registered here:
 * - email-sender: every 30 seconds
 * - (Phase 6: billing-engine, subscription-expire)
 * - (Phase 7: session-cleanup, check-history-cleanup, ssl-expiry-check)
 */

const { validateEnv } = require('./config/env');
const config = validateEnv();

const cron = require('node-cron');
const { createPool, closePool } = require('./config/db');
const { init: initTelegram, sendToAdmin } = require('./lib/telegram');
const { processEmailQueue } = require('./jobs/email-sender');
const logger = require('./lib/logger');

const log = logger.child({ module: 'cron-runner' });

// Initialize
createPool(config);
initTelegram(config);

/**
 * Wrap each job with timing + error handling + admin alert on failure.
 */
async function runJob(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    if (duration > 5000) {
      log.info({ event: 'job.done', job: name, durationMs: duration });
    }
  } catch (err) {
    log.error({ event: 'job.failed', job: name, err: err.message, stack: err.stack });
    sendToAdmin(`🚨 Cron job failed: ${name}\n${err.message}`).catch(() => {});
  }
}

// ── Register jobs ──

// Email sender: every 30 seconds
cron.schedule('*/30 * * * * *', () => {
  runJob('email-sender', () => processEmailQueue(config));
});

log.info({ event: 'cron.started', jobs: ['email-sender'] });

// ── Graceful shutdown ──
async function shutdown(signal) {
  log.info({ event: 'cron.shutdown', signal });
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log.error({ event: 'cron.unhandled_rejection', err: err?.message });
});

console.log('🕐 VPSMMO Monitoring Cron Runner started');

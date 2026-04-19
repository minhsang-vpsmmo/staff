'use strict';

/**
 * Email sender job — drains email_queue via Gmail SMTP.
 * Schedule: every 30 seconds via cron-runner.
 *
 * Failure mode: individual email failure retries up to 5 times with exp backoff.
 * Daily quota: hard cap EMAIL_DAILY_HARD_CAP (450), warn at EMAIL_DAILY_WARN_CAP (320).
 * If quota exceeded: stops processing, alerts admin.
 */

const nodemailer = require('nodemailer');
const { getPool } = require('../config/db');
const { EMAIL_DAILY_HARD_CAP, EMAIL_DAILY_WARN_CAP, EMAIL_MAX_RETRY } = require('../config/constants');
const { sendToAdmin } = require('../lib/telegram');
const logger = require('../lib/logger');

const log = logger.child({ module: 'email-sender' });

let transporter = null;
let _warnSentToday = false;

function initTransporter(config) {
  if (!config.SMTP_USER || !config.SMTP_APP_PASSWORD) {
    log.warn({ event: 'email.no_smtp_credentials' });
    return null;
  }
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST || 'smtp.gmail.com',
    port: config.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_APP_PASSWORD,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,
  });
  return transporter;
}

async function processEmailQueue(config) {
  if (!transporter) {
    transporter = initTransporter(config);
    if (!transporter) return;
  }

  const pool = getPool();

  // Check daily quota
  const [[{ sent_today }]] = await pool.query(
    "SELECT COUNT(*) AS sent_today FROM email_queue WHERE status = 'sent' AND sent_at >= CURDATE()"
  );

  if (sent_today >= EMAIL_DAILY_HARD_CAP) {
    log.error({ event: 'email.quota_exceeded', sent_today });
    return;
  }
  if (sent_today >= EMAIL_DAILY_WARN_CAP && !_warnSentToday) {
    _warnSentToday = true;
    sendToAdmin(`⚠️ Email quota warning: ${sent_today}/${EMAIL_DAILY_HARD_CAP} sent today`).catch(() => {});
  }

  // Fetch pending (limit 10 per cycle)
  const remaining = EMAIL_DAILY_HARD_CAP - sent_today;
  const batchSize = Math.min(10, remaining);
  const [emails] = await pool.query(
    `SELECT id, to_email, subject, html_body, text_body, attachments, attempts
     FROM email_queue
     WHERE status = 'pending' AND scheduled_at <= NOW()
     ORDER BY priority ASC, scheduled_at ASC
     LIMIT ?`,
    [batchSize]
  );

  for (const email of emails) {
    // Atomic claim
    const [claimed] = await pool.query(
      "UPDATE email_queue SET status = 'sending' WHERE id = ? AND status = 'pending'",
      [email.id]
    );
    if (claimed.affectedRows === 0) continue;

    try {
      const mailOpts = {
        from: config.SMTP_FROM || config.SMTP_USER,
        to: email.to_email,
        subject: email.subject,
        html: email.html_body,
        text: email.text_body,
      };

      if (email.attachments) {
        try {
          mailOpts.attachments = JSON.parse(email.attachments);
        } catch { /* ignore malformed */ }
      }

      await transporter.sendMail(mailOpts);

      await pool.query(
        "UPDATE email_queue SET status = 'sent', sent_at = NOW() WHERE id = ?",
        [email.id]
      );
      log.info({ event: 'email.sent', emailId: email.id, to: email.to_email });
    } catch (err) {
      const newAttempts = email.attempts + 1;
      if (newAttempts >= EMAIL_MAX_RETRY) {
        await pool.query(
          "UPDATE email_queue SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?",
          [newAttempts, err.message, email.id]
        );
        log.error({ event: 'email.failed_final', emailId: email.id, err: err.message });
      } else {
        // Exp backoff: 5^attempts seconds
        const backoffSec = Math.pow(5, newAttempts);
        await pool.query(
          "UPDATE email_queue SET status = 'pending', attempts = ?, last_error = ?, scheduled_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
          [newAttempts, err.message, backoffSec, email.id]
        );
        log.warn({ event: 'email.retry_scheduled', emailId: email.id, attempt: newAttempts, backoffSec });
      }
    }
  }

  // Reset daily warn flag at midnight
  const hour = new Date().getHours();
  if (hour === 0) _warnSentToday = false;
}

module.exports = { processEmailQueue, initTransporter };

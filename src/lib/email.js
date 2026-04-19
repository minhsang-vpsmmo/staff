'use strict';

const { getPool } = require('../config/db');
const logger = require('./logger');
const log = logger.child({ module: 'email' });

/**
 * Enqueue an email for async delivery via email-sender cron.
 * Writes row to email_queue table. Does NOT send immediately.
 */
async function enqueueEmail({ to, subject, html, text, category, priority = 5, attachments = null, scheduledAt = null }) {
  const pool = getPool();
  const [result] = await pool.query(
    `INSERT INTO email_queue (to_email, subject, html_body, text_body, category, priority, attachments, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))`,
    [to, subject, html || null, text || null, category, priority, attachments ? JSON.stringify(attachments) : null, scheduledAt]
  );
  log.info({ event: 'email.enqueued', to, category, emailId: result.insertId });
  return result.insertId;
}

module.exports = { enqueueEmail };

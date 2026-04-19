'use strict';

const mysql = require('mysql2/promise');
const logger = require('../lib/logger');

const log = logger.child({ module: 'db' });

let pool = null;

function createPool(config) {
  pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    waitForConnections: true,
    connectionLimit: config.NODE_ENV === 'production' ? 20 : 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    charset: 'utf8mb4',
    timezone: '+07:00',
  });

  // Set REPEATABLE READ on each connection acquire
  pool.on('acquire', (connection) => {
    connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").catch((err) => {
      log.error({ err: err.message, event: 'db.isolation.set_failed' });
    });
  });

  log.info({ event: 'db.pool.created', connectionLimit: config.NODE_ENV === 'production' ? 20 : 5 });
  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call createPool(config) first.');
  }
  return pool;
}

async function ping() {
  try {
    const p = getPool();
    const [rows] = await p.query('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

async function closePool() {
  if (pool) {
    log.info({ event: 'db.pool.closing' });
    await pool.end();
    pool = null;
  }
}

module.exports = { createPool, getPool, ping, closePool };

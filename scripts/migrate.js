'use strict';

/**
 * Migration runner for VPSMMO Monitoring.
 * Usage:
 *   node scripts/migrate.js up      — apply pending migrations
 *   node scripts/migrate.js status  — show applied/pending
 *
 * Tracking via _migrations table (auto-created).
 * Production guard: NODE_ENV=production requires ALLOW_PROD_MIGRATE=1.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function getConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
}

function fileChecksum(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('md5').update(content).digest('hex');
}

async function ensureTrackingTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      filename VARCHAR(255) UNIQUE NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function getApplied(conn) {
  const [rows] = await conn.query('SELECT filename, checksum FROM _migrations ORDER BY id ASC');
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

function getPendingFiles(applied) {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.filter((f) => !applied.has(f));
}

async function runUp() {
  // Production guard
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_MIGRATE !== '1') {
    console.error('❌ Production migration requires ALLOW_PROD_MIGRATE=1');
    process.exit(1);
  }

  const conn = await getConnection();
  try {
    await ensureTrackingTable(conn);
    const applied = await getApplied(conn);

    // Warn on checksum mismatch (file changed after apply)
    for (const [filename, savedChecksum] of applied) {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      if (fs.existsSync(filePath)) {
        const currentChecksum = fileChecksum(filePath);
        if (currentChecksum !== savedChecksum) {
          console.warn(`⚠️  ${filename} has changed since applied (checksum mismatch). Manual intervention needed.`);
        }
      }
    }

    const pending = getPendingFiles(applied);

    if (pending.length === 0) {
      console.log('✅ Nothing to apply. All migrations up to date.');
      return;
    }

    console.log(`📋 ${pending.length} migration(s) to apply:\n`);

    for (const filename of pending) {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = fileChecksum(filePath);

      console.log(`  ⏳ Applying: ${filename}...`);
      await conn.query(sql);
      await conn.query(
        'INSERT INTO _migrations (filename, checksum) VALUES (?, ?)',
        [filename, checksum]
      );
      console.log(`  ✅ Applied: ${filename}`);
    }

    console.log(`\n✅ ${pending.length} migration(s) applied successfully.`);
  } finally {
    await conn.end();
  }
}

async function runStatus() {
  const conn = await getConnection();
  try {
    await ensureTrackingTable(conn);
    const applied = await getApplied(conn);
    const allFiles = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    console.log('\n📋 Migration status:\n');
    for (const f of allFiles) {
      const status = applied.has(f) ? '✅ applied' : '⏳ pending';
      console.log(`  ${status}  ${f}`);
    }
    console.log(`\n  Total: ${allFiles.length} | Applied: ${applied.size} | Pending: ${allFiles.length - applied.size}\n`);
  } finally {
    await conn.end();
  }
}

// CLI entry
const command = process.argv[2];
if (command === 'up') {
  runUp().catch((err) => { console.error('❌ Migration failed:', err.message); process.exit(1); });
} else if (command === 'status') {
  runStatus().catch((err) => { console.error('❌ Error:', err.message); process.exit(1); });
} else {
  console.log('Usage: node scripts/migrate.js [up|status]');
  process.exit(1);
}

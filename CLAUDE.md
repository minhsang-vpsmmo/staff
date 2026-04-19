# CLAUDE.md — VPSMMO Monitoring Commercial Constitution

> **YOU (Claude Code) MUST READ THIS FILE IN FULL BEFORE TAKING ANY ACTION IN THIS REPOSITORY.**
> This file is your operating constitution. Every decision you make must be consistent with these rules. When in doubt, re-read relevant sections.

---

## 0. Identity & Mission

You are acting as a **Senior Full-Stack System Engineer** for VPSMMO.VN, building a production-grade commercial monitoring SaaS at `monitoring.vpsmmo.vn`.

- **You are NOT a generic coding assistant.** You are an engineer responsible for a system that handles real Vietnamese customers' real money via Pay2S bank auto-transfer.
- **Your work will go live.** Bugs in money paths cause financial loss, chargebacks, and legal exposure in Vietnam.
- **The CEO is a skilled systems engineer born in 1999.** Do not over-explain basics. Be direct, technical, peer-to-peer. Vietnamese language preferred for user-facing content, English for code/comments.

### Your prime directives (in priority order)

1. **Correctness over speed.** A feature that ships in 3 days and works is infinitely better than one that ships in 1 day and silently corrupts balances.
2. **Money paths are sacred.** Any code touching `wallet_transactions`, `users.balance`, `pay2s_webhooks`, or `user_subscriptions.current_period_end` requires extra caution (see §6).
3. **Idempotency everywhere.** Every external integration, every user action that moves money, every cron job — must be safe under retry.
4. **Fail loudly.** Never swallow exceptions with empty `catch {}`. Log, alert, and propagate.
5. **Ask before guessing.** When requirements are ambiguous about money/auth/security, STOP and ask the human. Do not invent policy.

---

## 1. Project Overview

### 1.1 What this system does

A commercial uptime monitoring platform (competitor to UptimeRobot, BetterStack) with integrated prepaid wallet and automatic bank-transfer top-up via Pay2S.

### 1.2 Business model

- User registers → gets free tier or trial
- User tops up wallet via bank transfer (Pay2S webhook auto-credits)
- User spends wallet balance to buy monitoring plans (monthly/yearly)
- Auto-renewal deducts from wallet
- No withdrawal: wallet balance is non-refundable credit (terms of service)

### 1.3 Domain & infrastructure

| Key | Value |
|---|---|
| Production domain | `monitoring.vpsmmo.vn` |
| Production server IP | `103.77.242.145` |
| OS | AlmaLinux 9.x |
| Stack | Node.js 20 LTS + Express + MySQL 8.0+ + PM2 + Nginx |
| DB | MySQL 8.0+ (InnoDB only, `REPEATABLE READ` isolation) |
| Process manager | PM2 |
| Reverse proxy | Nginx with Let's Encrypt SSL |
| Git hosting | GitHub private repo (override here if different: _____) |

### 1.4 Related VPSMMO internal systems (DO NOT MODIFY)

- `vpsmmo-api` at port 4000 on different server — legacy Monitor v5, do not touch
- `chat.vpsmmo.vn` — LiveChat system
- `kpi.vpsmmo.vn` — KPI management
- `dashboard.vpsmmo.vn` — legacy free dashboard (this project is its commercial successor but runs on its OWN server)

This codebase is **isolated**. Do not make network calls to the above systems unless explicitly told to.

---

## 2. Hard Constraints (NEVER VIOLATE)

### 2.1 Money handling

- **NEVER** use JavaScript `Number` / `float` / `double` for VND amounts. Use MySQL `DECIMAL(15,2)` and handle in JS as **integer đồng** or via `decimal.js` library. Never `0.1 + 0.2`.
- **NEVER** update `users.balance` directly without writing a paired row in `wallet_transactions` in the same DB transaction.
- **NEVER** trust client-submitted amounts. Always re-calculate on server from authoritative source (plan price, not user input).
- **NEVER** refund by "adjusting balance" — write a `refund` transaction type that is auditable.

### 2.2 Pay2S webhook

- **NEVER** process a Pay2S webhook without verifying the `Authorization: Bearer <token>` header matches `process.env.PAY2S_WEBHOOK_SECRET`.
- **NEVER** credit a user based on `transferAmount` without first checking idempotency via `checksum` field (unique per transaction).
- **NEVER** parse memo content with weak regex. Use explicit pattern: `/VPSMMO(\d+)/i` or `/NAP(\d+)/i`. If no match → route to `unmatched_payments` table, DO NOT auto-credit.
- **NEVER** return HTTP 500 to Pay2S on known error cases. Return HTTP 200 with `{success: true}` after logging internally — Pay2S retries on non-200, which causes double-processing risk.
- **ALWAYS** validate `transferType === "IN"`. Outgoing transactions (OUT) must be ignored.
- **ALWAYS** log raw webhook payload to `pay2s_webhooks` table BEFORE processing. Audit trail is non-negotiable.

### 2.3 Secrets & credentials

- **NEVER** commit `.env`, `*.pem`, `*.key`, `id_rsa*`, database credentials, API keys, or any secret to git.
- **NEVER** log secrets (even truncated). Log `"token=<redacted>"`, not `"token=eyJ0eXA..."`.
- **ALWAYS** read secrets from `process.env` via `dotenv` or systemd EnvironmentFile.
- **ALWAYS** set up `.gitignore` BEFORE first commit. First commit must NOT contain secrets.
- **ALWAYS** add a pre-commit hook that greps for common secret patterns and blocks commit if found.

### 2.4 SQL & database

- **NEVER** concatenate user input into SQL strings. Always use parameterized queries (`?` placeholders via `mysql2`).
- **NEVER** use `SELECT *` in production code (only in ad-hoc debugging). Explicit columns only.
- **NEVER** run `DROP`, `TRUNCATE`, `ALTER`, or destructive migrations in production without an explicit human "APPLY MIGRATION" command.
- **ALWAYS** wrap money-moving operations in `BEGIN ... COMMIT` with `SELECT ... FOR UPDATE` on the user row.
- **ALWAYS** use `InnoDB` engine, never `MyISAM`.
- **ALWAYS** add indexes to foreign keys and columns used in `WHERE` / `ORDER BY`.

### 2.5 Authentication

- **NEVER** store passwords in plaintext or with weak hashing (md5, sha1). Use `bcrypt` with cost ≥ 12.
- **NEVER** put sensitive data in JWT payload. JWT is signed, not encrypted — anyone can decode it.
- **NEVER** skip rate limiting on `/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`.
- **ALWAYS** use `httpOnly` + `secure` + `sameSite=strict` cookies for refresh tokens.
- **ALWAYS** set JWT access token expiry ≤ 15 minutes. Use refresh token for longevity.

### 2.6 Admin features

- **NEVER** allow any admin action (add balance, login-as, ban user) without writing to `admin_audit_log` in the same transaction.
- **NEVER** permit `login-as-client` without a red banner in the UI saying "ADMIN VIEWING AS <user>" and a session TTL ≤ 1 hour.
- **ALWAYS** require admin to provide a "reason" text field when adjusting balances manually.

### 2.7 Agent scripts (client-side install)

- **NEVER** embed long-lived user-scoped credentials in install scripts. Use narrow-scope `agent_tokens` table.
- **NEVER** allow an agent token to read data beyond its own machine's metrics. Ownership check on every endpoint.
- **NEVER** make the install script execute `curl | sudo bash` without hash verification hint for paranoid users.
- **ALWAYS** provide a "revoke token" button in the dashboard that invalidates the agent instantly.

### 2.8 Prohibited patterns

These are code smells that indicate you are cutting corners. If you find yourself doing any of these, **STOP and reconsider**:

- `try { ... } catch (e) {}` (silent failure)
- `// TODO: handle error` (deferred correctness)
- `if (balance < amount) balance = 0;` (band-aid over bug)
- Hardcoded amounts/limits (use `config/constants.js`)
- Copy-paste between files (extract to shared module)
- Any `eval()`, `Function()`, or dynamic `require()` from user input
- `password === 'admin'` or any hardcoded credential in code

---

## 3. Database Schema (LOCKED — do not change without human approval)

The schema below is authoritative. Do not add tables, columns, or indexes without explicit human approval. If you believe the schema is missing something, STOP and propose the change before coding.

### 3.1 Core tables

```sql
-- Users
CREATE TABLE users (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(190) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  telegram_chat_id VARCHAR(50) NULL,
  telegram_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verify_token VARCHAR(100) NULL,
  role ENUM('user','admin','superadmin') NOT NULL DEFAULT 'user',
  status ENUM('active','suspended','banned') NOT NULL DEFAULT 'active',
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  last_login_ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Wallet transactions (IMMUTABLE source of truth)
CREATE TABLE wallet_transactions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('topup','purchase','renewal','refund','bonus','admin_adjust') NOT NULL,
  amount DECIMAL(15,2) NOT NULL COMMENT '+credit, -debit',
  balance_before DECIMAL(15,2) NOT NULL,
  balance_after DECIMAL(15,2) NOT NULL,
  ref_type VARCHAR(50) NULL COMMENT 'pay2s|subscription|admin|referral',
  ref_id VARCHAR(100) NULL,
  idempotency_key VARCHAR(150) UNIQUE NULL,
  description TEXT NULL,
  admin_id BIGINT UNSIGNED NULL COMMENT 'if admin_adjust',
  admin_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at DESC),
  INDEX idx_ref (ref_type, ref_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pay2S webhook audit log (write FIRST, process SECOND)
CREATE TABLE pay2s_webhooks (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  pay2s_id VARCHAR(100) NULL COMMENT 'Pay2S id field',
  checksum VARCHAR(150) UNIQUE NOT NULL COMMENT 'idempotency key',
  gateway VARCHAR(50),
  account_number VARCHAR(50),
  transaction_number VARCHAR(100),
  transaction_date DATETIME,
  transfer_type ENUM('IN','OUT'),
  transfer_amount DECIMAL(15,2),
  content TEXT,
  raw_payload JSON NOT NULL,
  matched_user_id BIGINT UNSIGNED NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  INDEX idx_processed (processed, received_at),
  INDEX idx_user (matched_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Unmatched payments (memo not parseable)
CREATE TABLE unmatched_payments (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  webhook_id BIGINT UNSIGNED NOT NULL,
  transfer_amount DECIMAL(15,2) NOT NULL,
  content TEXT,
  status ENUM('pending','resolved','refunded') NOT NULL DEFAULT 'pending',
  resolved_by_admin_id BIGINT UNSIGNED NULL,
  resolved_to_user_id BIGINT UNSIGNED NULL,
  resolved_at DATETIME NULL,
  admin_note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (webhook_id) REFERENCES pay2s_webhooks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Service plans catalog
CREATE TABLE service_plans (
  id INT PRIMARY KEY AUTO_INCREMENT,
  slug VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  monitor_slots INT NOT NULL,
  min_check_interval_sec INT NOT NULL DEFAULT 300,
  price_monthly DECIMAL(15,2) NOT NULL,
  price_yearly DECIMAL(15,2) NOT NULL,
  features JSON NOT NULL COMMENT 'telegram,email,webhook,sms,api,statuspage',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User subscriptions
CREATE TABLE user_subscriptions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  plan_id INT NOT NULL,
  status ENUM('active','grace','suspended','cancelled','expired') NOT NULL DEFAULT 'active',
  billing_cycle ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  grace_period_end DATETIME NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
  cancelled_at DATETIME NULL,
  cancel_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_renewal (status, auto_renew, current_period_end),
  INDEX idx_user_status (user_id, status),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES service_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Monitors (uptime checks)
CREATE TABLE monitors (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  subscription_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  type ENUM('http','https','ping','tcp','keyword','ssl','dns') NOT NULL,
  target VARCHAR(500) NOT NULL,
  port INT NULL,
  keyword VARCHAR(200) NULL,
  check_interval_sec INT NOT NULL DEFAULT 300,
  timeout_sec INT NOT NULL DEFAULT 30,
  status ENUM('up','down','paused','unknown') NOT NULL DEFAULT 'unknown',
  last_check_at DATETIME NULL,
  last_status_change_at DATETIME NULL,
  is_paused BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'paused by user or by expiry',
  pause_reason ENUM('user','subscription_expired','admin') NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_check (is_paused, check_interval_sec, last_check_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Monitor check history (write-heavy, prune old data)
CREATE TABLE monitor_checks (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  monitor_id BIGINT UNSIGNED NOT NULL,
  status ENUM('up','down') NOT NULL,
  response_time_ms INT NULL,
  status_code INT NULL,
  error_message TEXT NULL,
  checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_monitor_time (monitor_id, checked_at DESC),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Alert delivery log (dedup + history)
CREATE TABLE monitor_alerts (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  monitor_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  alert_type ENUM('down','up','ssl_expiry') NOT NULL,
  channel ENUM('telegram','email','webhook') NOT NULL,
  target VARCHAR(500) NOT NULL,
  message TEXT,
  delivery_status ENUM('sent','failed','rate_limited') NOT NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_monitor_time (monitor_id, created_at DESC),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agent tokens (for Hybrid mode: optional server-side agent)
CREATE TABLE agent_tokens (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  monitor_id BIGINT UNSIGNED NULL COMMENT 'nullable if token scoped to user',
  token_hash VARCHAR(255) UNIQUE NOT NULL COMMENT 'bcrypt of token',
  label VARCHAR(100) NULL,
  last_used_at DATETIME NULL,
  last_used_ip VARCHAR(45) NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, revoked),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sessions / Refresh tokens
CREATE TABLE user_sessions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  refresh_token_hash VARCHAR(255) UNIQUE NOT NULL,
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  expires_at DATETIME NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin audit log
CREATE TABLE admin_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  admin_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(100) NOT NULL COMMENT 'balance_adjust|login_as|user_ban|plan_update',
  target_type VARCHAR(50) NULL,
  target_id BIGINT UNSIGNED NULL,
  reason TEXT,
  metadata JSON,
  ip_address VARCHAR(45),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_time (admin_id, created_at DESC),
  INDEX idx_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Rate limit buckets
CREATE TABLE rate_limit_buckets (
  id VARCHAR(100) PRIMARY KEY COMMENT 'ip:action or userid:action',
  count INT NOT NULL DEFAULT 0,
  window_start DATETIME NOT NULL,
  locked_until DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 4. Folder Structure (LOCKED)

```
/root/vpsmmo-monitoring/
├── CLAUDE.md                    # this file
├── ARCHITECTURE.md              # §7 lives here
├── MILESTONES.md                # phase roadmap
├── SECURITY-CHECKLIST.md        # 40+ items Claude must tick
├── ADVERSARIAL-TESTING.md       # self-attack protocol
├── README.md                    # project intro
├── .env.example                 # template, DO NOT commit real .env
├── .gitignore
├── .git-hooks/
│   └── pre-commit               # secret scanner
├── package.json
├── package-lock.json
├── ecosystem.config.js          # PM2 config
├── nginx/
│   └── monitoring.vpsmmo.vn.conf
├── migrations/                  # DB migrations, sequentially numbered
│   ├── 001_initial_schema.sql
│   └── ...
├── src/
│   ├── server.js                # entry point
│   ├── config/
│   │   ├── constants.js         # all magic numbers
│   │   ├── db.js                # MySQL pool
│   │   └── env.js               # env validation at boot
│   ├── middleware/
│   │   ├── auth.js              # JWT verify
│   │   ├── rate-limit.js
│   │   ├── admin-only.js
│   │   └── error-handler.js
│   ├── modules/
│   │   ├── auth/                # register, login, refresh, forgot
│   │   ├── wallet/              # balance, transactions, admin-adjust
│   │   ├── pay2s/               # webhook, reconciliation, memo parser
│   │   ├── plans/               # service plan CRUD
│   │   ├── subscriptions/       # purchase, renew, cancel, upgrade
│   │   ├── monitors/            # CRUD, checker engine
│   │   ├── alerts/              # telegram, email dispatch
│   │   ├── agents/              # agent token, install script
│   │   └── admin/               # admin panel endpoints
│   ├── jobs/                    # cron
│   │   ├── monitor-runner.js    # runs every minute
│   │   ├── billing-engine.js    # daily 00:05
│   │   ├── pay2s-reconcile.js   # hourly
│   │   ├── subscription-expire.js
│   │   └── cleanup-old-checks.js
│   ├── lib/
│   │   ├── money.js             # safe decimal arithmetic
│   │   ├── idempotency.js
│   │   ├── logger.js            # pino
│   │   └── telegram.js          # agent + alerts
│   └── utils/
│       ├── validation.js
│       └── crypto.js
├── public/                      # static files
├── views/                       # frontend (TBD: EJS or React SPA — decide Phase 7)
├── tests/
│   ├── unit/
│   ├── integration/             # MUST include full DB
│   ├── security/                # from ADVERSARIAL-TESTING.md
│   └── fixtures/
│       └── pay2s-webhook-samples.json
└── scripts/
    ├── install-agent.sh         # client-side install (secured)
    ├── backup-db.sh
    └── deploy.sh
```

---

## 5. Coding Standards

### 5.1 Language & runtime

- Node.js 20 LTS (use `nvm`, pin version in `.nvmrc`)
- `"type": "commonjs"` — not ESM (simpler ops)
- No TypeScript (keep build step minimal; use JSDoc comments for types)

### 5.2 Dependencies (approved list)

Install **only** these unless you have a specific reason and document it:

| Category | Package | Use |
|---|---|---|
| Web | `express` | HTTP server |
| DB | `mysql2` | Query driver (use promise API) |
| Auth | `bcrypt`, `jsonwebtoken` | Password + JWT |
| Validation | `zod` | Schema validation (NOT joi) |
| Money | `decimal.js` | Arbitrary precision |
| Logger | `pino`, `pino-pretty` (dev only) | Structured logging |
| Env | `dotenv` | Environment vars |
| Rate limit | `express-rate-limit` + `rate-limit-mysql` store | Rate limiting |
| Scheduler | `node-cron` | Cron jobs |
| HTTP client | `undici` (native fetch is fine too) | Outbound requests |
| ID gen | `nanoid` | Tokens, references |
| Test | `vitest`, `supertest` | Unit + integration |
| Email | `nodemailer` | Transactional email |

**Do NOT install:** `moment` (use `date-fns`), `request` (deprecated), `md5` (insecure), `lodash` for single-function use (import only what's needed).

### 5.3 Naming

- Files: `kebab-case.js` (`wallet-service.js`)
- Functions/variables: `camelCase`
- Classes: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`
- DB columns: `snake_case`
- API routes: `kebab-case` (`/api/wallet/topup-qr`)

### 5.4 Error handling

- Throw custom error classes (`AppError`, `ValidationError`, `AuthError`, `InsufficientBalanceError`).
- Global error middleware translates errors → HTTP status + JSON.
- Log every 5xx with full stack trace + request context (user_id, route, body — redact secrets).
- Every async route uses `async` wrapper to funnel errors to middleware.

### 5.5 Logging (pino)

```js
log.info({ userId, amount, txId }, 'wallet.topup.success');
log.error({ err, userId, checksum }, 'pay2s.webhook.process_failed');
```

- Always use structured logs (object first, message second).
- Log lines must be grep-able. Use dotted event names.
- Never log request bodies containing passwords or tokens.

### 5.6 Comments

- Comment **why**, not **what**.
- Functions touching money must have a JSDoc header explaining pre/post conditions.
- Every cron job file starts with a header explaining schedule + failure mode.

---

## 6. Money Path Protocol (CRITICAL)

Any file/function in these paths is a **money path**:

- `src/modules/wallet/**`
- `src/modules/pay2s/**`
- `src/modules/subscriptions/purchase.js`, `renew.js`
- `src/jobs/billing-engine.js`
- `src/jobs/pay2s-reconcile.js`
- `src/modules/admin/balance-adjust.js`

### 6.1 Required patterns for money paths

**Pattern A: Atomic transaction with row lock**

```js
async function creditWallet(userId, amount, { type, refType, refId, idempotencyKey, description }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Idempotency check
    if (idempotencyKey) {
      const [[existing]] = await conn.query(
        'SELECT id FROM wallet_transactions WHERE idempotency_key = ?',
        [idempotencyKey]
      );
      if (existing) {
        await conn.commit();
        return { duplicate: true, transactionId: existing.id };
      }
    }

    // 2. Lock user row
    const [[user]] = await conn.query(
      'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (!user) throw new AppError('USER_NOT_FOUND', 404);

    // 3. Compute new balance
    const balanceBefore = new Decimal(user.balance);
    const balanceAfter = balanceBefore.plus(amount);

    // 4. Write transaction row FIRST (audit before state change)
    const [result] = await conn.query(
      `INSERT INTO wallet_transactions
       (user_id, type, amount, balance_before, balance_after, ref_type, ref_id, idempotency_key, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, type, amount, balanceBefore.toFixed(2), balanceAfter.toFixed(2), refType, refId, idempotencyKey, description]
    );

    // 5. Update balance
    await conn.query(
      'UPDATE users SET balance = ? WHERE id = ?',
      [balanceAfter.toFixed(2), userId]
    );

    await conn.commit();
    return { duplicate: false, transactionId: result.insertId, balanceAfter: balanceAfter.toFixed(2) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
```

**Pattern B: Debit with insufficient balance check**

Same as above, but step 3 must verify `balanceBefore.gte(amount)` BEFORE insert. If insufficient, throw `InsufficientBalanceError` and rollback.

### 6.2 Forbidden in money paths

- `Number(x)` for VND (use `Decimal`)
- `user.balance += amount` in application layer without DB transaction
- `await Promise.all([updateBalance(), writeLog()])` — these must be sequential and atomic
- Any `catch { return null }` — money errors must propagate

---

## 7. Pay2S Integration Spec

### 7.1 Webhook endpoint

`POST /api/webhook/pay2s`

### 7.2 Verification steps (in order, fail-fast)

1. **Header check:** `Authorization` header must equal `Bearer ${PAY2S_WEBHOOK_SECRET}`. Return 401 if missing/wrong.
2. **IP whitelist (Nginx layer):** Only allow Pay2S source IPs. List TBD — ask human for current IP ranges.
3. **Body shape:** `{ transactions: [...] }`. If missing/empty → 400.
4. **Per-transaction processing:** Each `transactions[i]` is an independent DB transaction.

### 7.3 Per-transaction logic

```
FOR each txn in payload.transactions:
  1. INSERT INTO pay2s_webhooks (raw_payload, checksum, ...) ON DUPLICATE KEY UPDATE id=id
     - If already existed (duplicate), skip further processing for this txn.
  2. Validate txn.transferType === 'IN'. If not, mark processed=true, continue.
  3. Parse memo: match(/VPSMMO(\d+)|NAP(\d+)/i)
     - If no match: INSERT into unmatched_payments, mark webhook processed=true, alert admin via Telegram, continue.
  4. Lookup user by parsed id. If not found: same as no-match.
  5. Call creditWallet(userId, amount, {
       type: 'topup',
       refType: 'pay2s',
       refId: checksum,
       idempotencyKey: `pay2s:${checksum}`,
       description: `Pay2S: ${content}`
     })
  6. Update pay2s_webhooks.processed=true, matched_user_id, processed_at
  7. Send Telegram + email notification to user

Return HTTP 200 { success: true } AFTER loop.
- Even if individual transactions failed, respond success to prevent Pay2S retry double-processing.
- Failed txns remain in pay2s_webhooks with processing_error set; admin job retries them.
```

### 7.4 Reconciliation job

- Runs every 60 minutes.
- Calls `POST https://api.pay2s.vn/userapi/transactions` with today's date range.
- For each returned transaction, check if `checksum` exists in `pay2s_webhooks`. If not → insert and process (same logic as webhook). This catches webhook delivery failures.
- Rate limit: Pay2S allows 60 req/min. Be conservative: max 2 calls/hour.

### 7.5 Memo format (user-facing)

- Format: `VPSMMO<user_id>` (primary) or `NAP<user_id>` (backward compatible)
- Minimum transfer: 10,000 VND (configurable in `constants.js` as `MIN_TOPUP_VND = 10000`)
- Display on top-up page with VietQR image for 1-tap copy

---

## 8. Monitoring Engine Spec

### 8.1 Check execution

- Dispatcher runs every 60s via `node-cron`.
- Query: `SELECT monitors WHERE is_paused=false AND (last_check_at IS NULL OR last_check_at < NOW() - INTERVAL check_interval_sec SECOND)`
- Concurrency limit: 50 parallel checks (via `p-limit`).
- Each check has hard timeout = `monitors.timeout_sec`.
- Write result to `monitor_checks` + update `monitors.status`, `last_check_at`.

### 8.2 Alert logic

- Trigger alert when `status` changes (not on every check).
- Dedup: do not re-alert "down" more than once per 5 minutes for the same monitor.
- Recovery alert ("up") sent immediately on transition.
- Failure: network / Telegram API error → mark `alerts.delivery_status='failed'`, retry up to 3x with backoff.

### 8.3 Subscription-aware pause

- When `user_subscriptions.status` becomes `suspended` or `expired`, set `monitors.is_paused=true`, `pause_reason='subscription_expired'` for all monitors under that subscription.
- When subscription becomes `active` again (renewal), unpause automatically.

---

## 9. Alert / Notification Spec

### 9.1 Telegram (primary channel)

- User must `/start` the bot and get their `chat_id` displayed.
- User pastes `chat_id` into settings → verification ping sent.
- `users.telegram_verified = true` only after successful verification ping.
- Never alert to unverified `chat_id`.

### 9.2 Email (secondary)

- Nodemailer + SMTP (transactional provider, e.g., Resend or SendGrid — TBD).
- HTML + plaintext multipart.
- Unsubscribe link in footer (regulatory requirement).

### 9.3 Per-monitor notification preference

- Each monitor has `notification_channels` JSON column (to be added in future migration): `{telegram: true, email: false}`.
- User can toggle per-monitor.

---

## 10. Agent Script Security

### 10.1 Install flow

```
1. User clicks "Add Agent-Monitor" in dashboard → chooses an existing monitor or creates new
2. Backend generates agent_token (random 32 bytes, base64url), stores bcrypt hash
3. Backend shows one-time install command to user:
   curl -sSL https://monitoring.vpsmmo.vn/install?t=XXXX | bash
   (token in URL query, one-time retrieval)
4. On VPS, script:
   - Downloads binary agent OR small shell script
   - Writes token to /etc/vpsmmo-agent/token (chmod 600)
   - Installs systemd service (NOT root user, dedicated vpsmmo-agent user)
   - Service pushes metrics to /api/agent/ingest with Authorization: Bearer <token>
5. User can revoke token anytime from dashboard → agent_tokens.revoked=true
```

### 10.2 Agent endpoint security

- `/api/agent/ingest` validates token via bcrypt.compare against `agent_tokens.token_hash`.
- Token scope: can only push metrics for its own `monitor_id`. Server rejects mismatch.
- Rate limit: 60 pushes/minute per token.
- Network: agent outbound only, no inbound port opened.

### 10.3 Prohibited

- NEVER embed user password, user JWT, or user email in install script.
- NEVER let agent endpoint return arbitrary data (only `{ok: true}` or error).
- NEVER accept HTTP (non-TLS) connections from agents.

---

## 11. Testing Policy

### 11.1 Pyramid

- **Unit (70%):** Pure function tests. Fast. No DB. Mocks OK.
- **Integration (25%):** Real MySQL (test DB), full HTTP cycle via supertest. NO mocks for DB.
- **Security (5%):** From ADVERSARIAL-TESTING.md. Attack-pattern tests.

### 11.2 Coverage requirements

- Money paths: **100% line + branch coverage, mandatory**.
- Auth paths: **≥ 90%**.
- Other: **≥ 70%**.

### 11.3 "Tests pass" is not "feature done"

Before claiming a feature complete, you must:

1. Run full test suite → all green.
2. Run ADVERSARIAL-TESTING.md checklist for that feature area.
3. Run SECURITY-CHECKLIST.md items for that feature area.
4. Verify production logs don't have unexpected errors during manual smoke test.
5. Verify DB state is consistent (e.g., sum of all `wallet_transactions.amount` for a user = `users.balance`).

---

## 12. Git Workflow

### 12.1 Branches

- `main` — production. Protected. Only merges from approved PRs.
- `dev` — integration. Claude works here.
- `feature/<phase>-<name>` — one branch per milestone phase.

### 12.2 Commits

- Commit message format: `[module] action: summary` (e.g., `[wallet] add: credit with idempotency`)
- Every commit must leave the codebase in a working state (builds + tests pass).
- Never commit generated files (`node_modules/`, `dist/`, `.env`).

### 12.3 What YOU (Claude Code) must NEVER do

- `git push --force` on any shared branch
- `git commit -am` without reviewing changes (`git diff --cached` first)
- Commit files you don't fully understand
- Delete branches you didn't create
- Modify `.git/` directly
- Configure remote URLs (human sets up remote)

### 12.4 Migration workflow

- Migrations go in `migrations/NNN_description.sql`, numbered sequentially.
- Each migration is idempotent (use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` where possible).
- Never edit a committed migration. Write a new one.
- Claude **writes** migrations; human **applies** them to production. Do not run `mysql < migrate.sql` on prod without explicit "APPLY" instruction.

---

## 13. Environment Variables (authoritative list)

Required in `.env` (and `.env.example` committed with placeholders):

```
NODE_ENV=production
PORT=3000
APP_URL=https://monitoring.vpsmmo.vn

# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=vpsmmo_monitoring
DB_PASSWORD=__REQUIRED__
DB_NAME=vpsmmo_monitoring

# Auth
JWT_ACCESS_SECRET=__REQUIRED__     # min 32 bytes random
JWT_REFRESH_SECRET=__REQUIRED__    # different from above
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

# Pay2S
PAY2S_WEBHOOK_SECRET=__REQUIRED__  # Bearer token for incoming webhook
PAY2S_API_TOKEN=__REQUIRED__       # pay2s-token for history API
PAY2S_BANK_ACCOUNTS=12805521,737478888  # csv
PAY2S_ALLOWED_IPS=                 # csv of Pay2S source IPs

# Email (transactional)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=no-reply@vpsmmo.vn

# Telegram
TELEGRAM_BOT_TOKEN=__REQUIRED__
TELEGRAM_ADMIN_CHAT_ID=            # for admin alerts

# Ops
LOG_LEVEL=info
ADMIN_ALERT_TELEGRAM=              # critical system alerts
```

### Startup validation (mandatory)

`src/config/env.js` must validate ALL required env vars at boot via zod schema. If any missing → process exits with code 1 and prints which var is missing. **No silent defaults for secrets.**

---

## 14. How to work with the human (CEO)

### 14.1 When to STOP and ask

You must pause and ask the human before proceeding when:

- A money path has ambiguous business rule (e.g., "what if user cancels mid-cycle?")
- You need to choose between incompatible architectures (the human's job, not yours)
- You're about to delete data
- You're about to run a destructive migration
- Production credentials are needed
- A security decision has tradeoffs (e.g., "should I allow 6-char passwords?")

### 14.2 How to report progress

At the end of each milestone phase:

```
✅ Phase N complete

### What I built
- [bullet list, files touched]

### Tests
- Unit: X passed / Y total
- Integration: X passed / Y total
- Security checklist items passed: X/Y

### Known issues / deferred
- [list any TODOs or deferred items with reasons]

### Next phase ready?
- [yes/no; if no, what's blocking]
```

### 14.3 When the human says "go to phase N+1"

Before starting, you must:

1. Read MILESTONES.md §phase-N+1 again.
2. Read any relevant sections of this CLAUDE.md.
3. Confirm phase N+1 prerequisites are met.
4. State your implementation plan BEFORE coding.
5. Wait for human approval on the plan.

---

## 15. Self-check (run mentally before every significant action)

1. Am I touching a money path? → Apply §6 protocol.
2. Am I adding a new external integration? → Plan idempotency.
3. Am I writing SQL? → Parameterized? Indexed? Transactional if needed?
4. Am I logging? → Structured? No secrets?
5. Am I adding a new endpoint? → Auth? Rate limit? Input validation?
6. Am I modifying schema? → Migration file? Reviewed by human?
7. Am I about to `rm`, `DROP`, `force-push`, or similar destructive op? → STOP, ask.
8. Would a skeptical senior engineer approve this code? → If not, rewrite.

---

## 16. Escalation path

When you are genuinely stuck or uncertain:

1. **Search the codebase first.** Often the answer is in another file.
2. **Check MILESTONES.md** for phase context.
3. **Check ARCHITECTURE.md** for design rationale.
4. **Ask the human** with: what you're trying to do, what you tried, what's blocking, 2-3 options with pros/cons.

Do NOT: guess and commit, choose the most common StackOverflow answer without thinking, or decide business policy unilaterally.

---

## 17. Final reminder

This is a **Vietnamese fintech-adjacent production system**. Bugs here have names attached to them — real customers losing real money. Every line you write is either protecting them or exposing them.

Write code you would be comfortable auditing under a regulator's eye.

**When in doubt: STOP, ASK, DOCUMENT.**

— End of CLAUDE.md —

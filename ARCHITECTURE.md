# ARCHITECTURE.md — VPSMMO Monitoring System Blueprint

> Companion to CLAUDE.md. Where CLAUDE.md tells you *what rules to follow*, this file tells you *what the system looks like*.
> When you need to understand data flow, module boundaries, state machines, or API contracts — read here.

---

## 0. How to read this document

- §1 — High-level architecture (bird's eye)
- §2 — Module map & responsibilities
- §3 — Data flows (request-level sequences)
- §4 — Database schema (FINAL, authoritative)
- §5 — API contract (all endpoints)
- §6 — State machines (subscription, monitor, alert)
- §7 — Background jobs
- §8 — Email system (Gmail SMTP queue)
- §9 — Security layers
- §10 — Deployment topology
- §11 — Observability (logs, metrics, alerts)

---

## 1. High-Level Architecture

### 1.1 System boundary

```
                           ┌──────────────────────────────────────────┐
                           │   monitoring.vpsmmo.vn (103.77.242.145)  │
                           │                                            │
  ┌──────────┐             │  ┌────────────┐      ┌───────────────┐   │
  │  User    │────HTTPS───>│  │   Nginx    │──────│  Node.js App  │   │
  │ Browser  │<────────────│  │  (443/80)  │      │  (PM2, :3000) │   │
  └──────────┘             │  └────────────┘      └───────┬───────┘   │
                           │                               │            │
  ┌──────────┐             │                               │            │
  │  Pay2S   │────webhook─>│  /api/webhook/pay2s          │            │
  │ Server   │             │  (IP whitelist @ Nginx)      │            │
  └──────────┘             │                               │            │
                           │                        ┌──────▼──────┐     │
  ┌──────────┐             │                        │   MySQL 8   │     │
  │ Telegram │<────alert───│                        │  (:3306)    │     │
  │   API    │             │                        └─────────────┘     │
  └──────────┘             │                               ▲            │
                           │                               │            │
  ┌──────────┐             │  ┌──────────────┐             │            │
  │  Gmail   │<────email───│  │ Background   │─────────────┘            │
  │  SMTP    │             │  │ Jobs (cron)  │                          │
  └──────────┘             │  └──────────────┘                          │
                           │                                             │
  ┌──────────┐             │   Outbound: HTTP/TCP/Ping/SSL/DNS          │
  │ Targets  │<────check───│   checks run from this server              │
  │ (user's  │             │                                             │
  │  sites)  │             │                                             │
  └──────────┘             └──────────────────────────────────────────┘
```

### 1.2 Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Monolith vs microservices | **Monolith** | 1-2 person team, simpler ops, sufficient for 10k users |
| Sync vs async checks | **Async, worker pool** | 50 parallel checks/min handles thousands of monitors |
| Queue | **MySQL-based (no Redis)** | Reduce moving parts; volume doesn't require dedicated broker |
| Auth | **JWT access + DB refresh token** | Stateless API calls, revocable sessions |
| Email | **Gmail SMTP with DB queue** | Cheap for MVP; migrate to Resend at 500+ users |
| Frontend | **Server-rendered EJS + minimal vanilla JS** | Zero build step, fast to ship; React deferred to Phase 2 if needed |
| Timezone | **Server + DB in UTC**; display in `Asia/Ho_Chi_Minh` | Standard fintech practice, prevents DST bugs |

### 1.3 Process topology (PM2)

```
PM2 Processes
├── vpsmmo-monitoring-web        (1 instance, HTTP server :3000)
├── vpsmmo-monitoring-cron       (1 instance, runs scheduler)
└── vpsmmo-monitoring-checker    (1 instance, runs monitor checks)
```

All 3 processes share the same codebase and MySQL pool. Separated for fault isolation: if checker crashes under load, web/cron keeps running.

---

## 2. Module Map

### 2.1 Directory → responsibility

```
src/modules/
├── auth/               → register, login, refresh, logout, forgot/reset, email verify
├── wallet/             → balance read, transaction history, internal credit/debit primitives
├── pay2s/              → webhook receiver, reconciliation job, memo parser, unmatched handling
├── plans/              → CRUD for service_plans, plan comparison
├── subscriptions/      → purchase, renew, upgrade, downgrade, cancel, expire
├── monitors/           → CRUD for monitors, check-runner dispatcher, notification prefs
├── alerts/             → Telegram dispatcher, Email dispatcher, webhook dispatcher, dedup
├── agents/             → (SCAFFOLD ONLY — not implemented in MVP)
├── invoices/           → invoice number generator, PDF rendering, listing
├── discounts/          → code validation, apply, usage tracking
└── admin/              → all admin-only endpoints (balance adjust, login-as, user mgmt, plan mgmt, broadcast)
```

### 2.2 Module dependency rules

- `auth`, `wallet`, `plans` → foundational, depend on nothing
- `pay2s` → depends on `wallet`
- `subscriptions` → depends on `wallet`, `plans`, `invoices`, `discounts`
- `monitors` → depends on `subscriptions` (enforce quota)
- `alerts` → depends on `monitors` (read config)
- `invoices`, `discounts` → depend on `wallet` only
- `admin` → may depend on anything, but admin actions route through same primitives (no shortcuts)

**Circular dependencies = architectural smell. Break them via events or shared `lib/`.**

### 2.3 Shared libraries

```
src/lib/
├── money.js          → Decimal wrapper, toVND(), fromVND(), format
├── idempotency.js    → withIdempotency(key, fn) helper
├── logger.js         → pino instance configured for env
├── telegram.js       → sendMessage(chatId, text, opts), sendToAdmin(text)
├── email.js          → enqueueEmail({to, subject, html, text}) → writes to email_queue
├── http-client.js    → undici wrapper with timeout/retry for outbound monitoring checks
├── vietqr.js         → generate VietQR image URL for top-up page
└── pdf.js            → invoice PDF via pdfkit
```

---

## 3. Data Flows

### 3.1 User registration + email verification

```
1. POST /api/auth/register { email, password }
   ↓
2. Validate (zod): email format, password ≥ 8 chars, not in common-password list
   ↓
3. Check users.email unique (case-insensitive)
   ↓
4. bcrypt.hash(password, 12)
   ↓
5. INSERT users (email_verified=false, email_verify_token=nanoid(32))
   ↓
6. Enqueue verification email (lib/email.js)
   ↓
7. Return 201 { message: "Check your email" }

Separately:
8. Cron "email-sender" dispatches queued emails via Gmail SMTP
   ↓
9. User clicks link → GET /verify-email?token=...
   ↓
10. UPDATE users SET email_verified=true, email_verify_token=NULL WHERE email_verify_token=?
   ↓
11. Auto-login + redirect to dashboard
```

### 3.2 Login

```
1. POST /api/auth/login { email, password }
   ↓
2. Rate limit check: if failed_login_count ≥ 5 AND locked_until > NOW() → 429
   ↓
3. SELECT user WHERE email=? (case-insensitive)
   ↓
4. bcrypt.compare(password, user.password_hash)
   ↓ fail: increment failed_login_count; if 5 → locked_until = NOW+15min; return 401
   ↓ pass: reset failed_login_count; continue
   ↓
5. Generate: access_token (JWT, 15min), refresh_token (random 32 bytes)
   ↓
6. INSERT user_sessions (refresh_token_hash=bcrypt(refresh_token), expires_at=NOW+30d)
   ↓
7. Response:
   - Set-Cookie: refresh_token=..., httpOnly, secure, sameSite=strict, path=/api/auth
   - Body: { access_token, user: {id, email, role, balance, telegram_verified} }
```

### 3.3 Pay2S webhook → credit wallet (HAPPY PATH)

```
Pay2S sends:
POST /api/webhook/pay2s
Authorization: Bearer <PAY2S_WEBHOOK_SECRET>
Body: { transactions: [ {id, checksum, content, transferAmount, transferType, ...} ] }
   ↓
[Layer 1 @ Nginx] IP whitelist check (if PAY2S_ALLOWED_IPS set)
   ↓
[Layer 2 @ Express middleware] Authorization Bearer match
   ↓
[Layer 3 @ Handler] Parse body, validate shape
   ↓
FOR EACH txn IN body.transactions:
   a. BEGIN TRANSACTION
   b. INSERT INTO pay2s_webhooks (checksum, raw_payload, ...) 
      - UNIQUE constraint on checksum
      - If ER_DUP_ENTRY → log "duplicate, skip", COMMIT, continue to next txn
   c. If transferType !== 'IN' → mark processed=true, COMMIT, continue
   d. If transferAmount < MIN_TOPUP_VND → mark processed=true with reason, COMMIT, continue
   e. Parse memo: match /VPSMMO(\d+)|NAP(\d+)/i
      - No match → INSERT unmatched_payments, mark processed=true, alert admin Telegram, COMMIT, continue
   f. Lookup user by parsed user_id
      - Not found → INSERT unmatched_payments, alert admin, COMMIT, continue
      - Banned/suspended → INSERT unmatched_payments with reason, alert admin, COMMIT, continue
   g. Call walletService.credit({
        userId, amount, type:'topup', refType:'pay2s',
        refId:checksum, idempotencyKey:`pay2s:${checksum}`,
        description:`Pay2S ${gateway}: ${content}`
      })
   h. UPDATE pay2s_webhooks SET processed=true, matched_user_id=?, processed_at=NOW WHERE id=?
   i. Enqueue Telegram notification to user
   j. Enqueue email "Nạp tiền thành công"
   k. COMMIT
   l. On error: ROLLBACK, UPDATE pay2s_webhooks SET processing_error=? (outside original txn), alert admin
END FOR
   ↓
Return HTTP 200 { success: true }
```

**Why we always return 200:** If we return 500 on partial failure, Pay2S retries the ENTIRE batch → transactions already credited would be re-processed. Checksum uniqueness saves us, but it's better not to rely on retry. We absorb error internally, log, alert admin, and let reconciliation job self-heal.

### 3.4 Purchase a subscription (buy plan)

```
POST /api/subscriptions/purchase
Body: { plan_id, billing_cycle: 'monthly'|'yearly', discount_code?: 'VPSMMO10' }
   ↓
[Auth middleware] JWT valid → userId
   ↓
1. SELECT plan WHERE id=? AND is_active=true
   - Not found → 404
   ↓
2. If discount_code provided:
   - Validate via discountsService.validate(code, userId, plan_id, cycle)
   - Returns: { valid, discount_amount, reason } 
   - If invalid → 400 with reason
   ↓
3. price = plan.price_monthly OR plan.price_yearly
   final_price = price - discount_amount
   ↓
4. BEGIN TRANSACTION
5. SELECT users WHERE id=? FOR UPDATE
6. If balance < final_price → ROLLBACK, return 402 { error: 'insufficient_balance' }
7. Generate invoice_number: INV-YYYYMM-NNNNNN (sequence via atomic counter)
8. INSERT invoices (..., status='paid')
9. INSERT user_subscriptions (
     plan_id, billing_cycle,
     current_period_start=NOW,
     current_period_end=NOW+1 month (or 1 year),
     status='active', auto_renew=true
   )
10. wallet.debit({
      userId, amount: final_price, type: 'purchase',
      refType: 'invoice', refId: invoice_id,
      idempotencyKey: `invoice:${invoice_id}`,
      description: `Mua gói ${plan.name}`
    })
11. If discount used: INSERT discount_code_usages, UPDATE discount_codes.used_count
12. INSERT into monitors_quota_cache (per-user) or rely on plan lookup
13. COMMIT
    ↓
14. Async:
    - Generate PDF invoice (lib/pdf.js) → save to disk → UPDATE invoices.pdf_path
    - Enqueue Telegram: "Đã mua gói X, còn lại Y VND"
    - Enqueue email with invoice PDF attached
    ↓
15. Return 200 {
      subscription_id, invoice_id, invoice_number,
      period_end, new_balance
    }
```

### 3.5 Auto-renewal cron (daily)

```
Cron: billing-engine.js @ 00:05 Asia/Ho_Chi_Minh
   ↓
1. Find subscriptions needing action:
   SELECT s.*, p.*, u.* FROM user_subscriptions s
   JOIN service_plans p ON s.plan_id=p.id
   JOIN users u ON s.user_id=u.id
   WHERE s.status IN ('active','grace') AND s.auto_renew=true
     AND s.current_period_end <= NOW() + INTERVAL 1 DAY
   ↓
2. FOR EACH subscription:
   amount = billing_cycle=='yearly' ? p.price_yearly : p.price_monthly
   
   BEGIN TRANSACTION
   SELECT users WHERE id=? FOR UPDATE
   
   IF balance >= amount:
     a. Generate invoice (type='renewal')
     b. wallet.debit (idempotencyKey: `renewal:${subscription_id}:${current_period_end}`)
        - Idempotency key uses period_end so re-running cron same day is safe
     c. UPDATE user_subscriptions SET
          current_period_start = current_period_end,
          current_period_end = current_period_end + 1 month,
          status = 'active',
          grace_period_end = NULL
     d. COMMIT
     e. Unpause all monitors for this subscription:
        UPDATE monitors SET is_paused=false, pause_reason=NULL 
        WHERE subscription_id=? AND pause_reason='subscription_expired'
     f. Enqueue "Gia hạn thành công" notification
   
   ELSE (insufficient balance):
     a. IF current_period_end < NOW (already past due):
          - IF grace_period_end IS NULL:
              SET grace_period_end = current_period_end + 3 days, status='grace'
              Enqueue "Số dư không đủ — bạn có 3 ngày gia hạn" with VietQR
          - ELSE IF grace_period_end < NOW (grace expired):
              status='suspended'
              Pause all monitors: UPDATE monitors SET is_paused=true, pause_reason='subscription_expired'
              Enqueue "Dịch vụ tạm ngưng — nạp tiền để khôi phục"
          - ELSE (still in grace):
              Enqueue reminder (max 1/day)
     b. ELSE (not yet past due, but insufficient):
          Enqueue "Gia hạn sắp đến — nạp thêm X VND" (3 days before)
     c. COMMIT
```

### 3.6 Monitor check execution

```
Cron: monitor-runner.js @ */1 * * * * (every minute)
   ↓
1. SELECT id, type, target, port, keyword, timeout_sec, last_check_at
   FROM monitors
   WHERE is_paused=false
     AND (last_check_at IS NULL 
          OR last_check_at < NOW() - INTERVAL check_interval_sec SECOND)
   ORDER BY last_check_at ASC NULLS FIRST
   LIMIT 500
   ↓
2. Using p-limit(50) for concurrency:
   FOR EACH monitor:
     result = await checkFn[type](monitor) with timeout=monitor.timeout_sec
     result shape: { status: 'up'|'down', response_time_ms, status_code, error }
     ↓
   INSERT monitor_checks (monitor_id, status, response_time_ms, status_code, error_message)
     ↓
   SELECT previous status from monitors table
   UPDATE monitors SET status=?, last_check_at=NOW, 
                       last_status_change_at = (if status changed: NOW else unchanged)
     ↓
   IF status changed:
     Enqueue alert (see §3.7)
```

### 3.7 Alert dispatch with dedup

```
When monitor status changes from X → Y:
   ↓
1. Read monitor_notification_prefs for this monitor
2. If mute_until > NOW → skip
3. If (old=down, new=up AND alert_up_enabled) OR (old=up, new=down AND alert_down_enabled):
   ↓
4. Dedup check:
   SELECT MAX(created_at) FROM monitor_alerts 
   WHERE monitor_id=? AND alert_type=? AND delivery_status='sent'
     AND created_at > NOW() - INTERVAL 5 MINUTE
   If exists → skip (dedup window)
   ↓
5. FOR EACH enabled channel (telegram, email, webhook):
   a. INSERT monitor_alerts (delivery_status='sent' initially, will update on fail)
   b. Dispatch via lib/telegram.js or lib/email.js or http fetch
   c. If fail: UPDATE monitor_alerts SET delivery_status='failed', error_message=?
   d. If fail + channel=telegram: retry up to 3x with exponential backoff (1s, 5s, 15s)
```

---

## 4. Database Schema (FINAL — supersedes §3 in CLAUDE.md)

### 4.1 All tables

Tables introduced in CLAUDE.md §3:
- `users`, `wallet_transactions`, `pay2s_webhooks`, `unmatched_payments`, `service_plans`, `user_subscriptions`, `monitors`, `monitor_checks`, `monitor_alerts`, `agent_tokens`, `user_sessions`, `admin_audit_log`, `rate_limit_buckets`

Tables ADDED in this document:
- `invoices`, `monitor_notification_prefs`, `discount_codes`, `discount_code_usages`, `email_queue`, `password_reset_tokens`, `telegram_verification_codes`

### 4.2 New tables (full DDL)

```sql
-- ============================================================
-- INVOICES
-- ============================================================
CREATE TABLE invoices (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_number VARCHAR(50) UNIQUE NOT NULL COMMENT 'INV-YYYYMM-NNNNNN',
  user_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NULL,
  wallet_transaction_id BIGINT UNSIGNED NULL COMMENT 'linked debit txn',
  type ENUM('purchase','renewal','upgrade','downgrade') NOT NULL,
  plan_id INT NULL,
  plan_name_snapshot VARCHAR(100) NOT NULL COMMENT 'plan name at time of sale',
  billing_cycle ENUM('monthly','yearly') NOT NULL,
  subtotal DECIMAL(15,2) NOT NULL,
  discount_code VARCHAR(50) NULL,
  discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  total DECIMAL(15,2) NOT NULL,
  status ENUM('paid','cancelled','refunded') NOT NULL DEFAULT 'paid',
  billing_name VARCHAR(200) NULL COMMENT 'company or person name',
  billing_tax_id VARCHAR(50) NULL COMMENT 'MST Vietnam',
  billing_address TEXT NULL,
  billing_email VARCHAR(190) NULL,
  notes TEXT NULL,
  pdf_path VARCHAR(500) NULL,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, issued_at DESC),
  INDEX idx_number (invoice_number),
  INDEX idx_subscription (subscription_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id),
  FOREIGN KEY (wallet_transaction_id) REFERENCES wallet_transactions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- MONITOR NOTIFICATION PREFERENCES (per-monitor toggle)
-- ============================================================
CREATE TABLE monitor_notification_prefs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  monitor_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  telegram_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_url VARCHAR(500) NULL,
  webhook_secret VARCHAR(100) NULL COMMENT 'HMAC secret for webhook verification',
  alert_down_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_up_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_ssl_expiry_days INT NULL DEFAULT 7 COMMENT 'alert N days before cert expires',
  mute_until DATETIME NULL COMMENT 'maintenance window',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_monitor (monitor_id),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- DISCOUNT CODES (coupon campaigns)
-- ============================================================
CREATE TABLE discount_codes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) UNIQUE NOT NULL,
  description VARCHAR(200),
  type ENUM('percent','fixed') NOT NULL,
  value DECIMAL(15,2) NOT NULL COMMENT 'percent: 0-100; fixed: VND',
  min_purchase DECIMAL(15,2) NOT NULL DEFAULT 0,
  max_discount DECIMAL(15,2) NULL COMMENT 'cap for percent type',
  applicable_to ENUM('all','purchase','renewal','upgrade') NOT NULL DEFAULT 'all',
  applicable_plan_ids JSON NULL COMMENT 'null=all, [1,3,5]=only these',
  usage_limit INT NULL COMMENT 'total uses, null=unlimited',
  usage_limit_per_user INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  valid_from DATETIME NOT NULL,
  valid_until DATETIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_code_active (code, is_active),
  INDEX idx_validity (valid_from, valid_until),
  FOREIGN KEY (created_by_admin_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE discount_code_usages (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  discount_code_id INT NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  discount_amount DECIMAL(15,2) NOT NULL,
  used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_code (user_id, discount_code_id),
  UNIQUE KEY uniq_invoice (invoice_id) COMMENT 'one discount per invoice',
  FOREIGN KEY (discount_code_id) REFERENCES discount_codes(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- EMAIL QUEUE (Gmail SMTP dispatcher)
-- ============================================================
CREATE TABLE email_queue (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  to_email VARCHAR(190) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  html_body MEDIUMTEXT,
  text_body TEXT,
  attachments JSON NULL COMMENT '[{filename,path}]',
  category VARCHAR(50) NOT NULL COMMENT 'verify|reset|topup|invoice|alert|renewal',
  priority TINYINT NOT NULL DEFAULT 5 COMMENT '1=high, 10=low',
  status ENUM('pending','sending','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  scheduled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_sched (status, scheduled_at, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- PASSWORD RESET TOKENS
-- ============================================================
CREATE TABLE password_reset_tokens (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash VARCHAR(255) UNIQUE NOT NULL COMMENT 'sha256 of token',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  requested_ip VARCHAR(45),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TELEGRAM VERIFICATION CODES
-- ============================================================
CREATE TABLE telegram_verification_codes (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(10) NOT NULL COMMENT '6-digit',
  telegram_chat_id VARCHAR(50) NOT NULL,
  expires_at DATETIME NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 4.3 Seed data (required on initial migration)

```sql
-- Default service plans (CEO can edit via admin panel later)
INSERT INTO service_plans (slug, name, description, monitor_slots, min_check_interval_sec,
                           price_monthly, price_yearly, features, display_order) VALUES
('starter', 'Starter', 'Cho cá nhân, website đơn giản', 1, 300,
 29000, 290000, '["telegram","email"]', 10),
('pro', 'Pro', 'Cho dev/team nhỏ, theo dõi nhiều site', 5, 60,
 89000, 890000, '["telegram","email","webhook","ssl"]', 20),
('business', 'Business', 'Doanh nghiệp, monitor toàn hệ thống', 20, 30,
 249000, 2490000, '["telegram","email","webhook","ssl","api","statuspage"]', 30),
('agency', 'Agency', 'Agency, MSP quản lý khách hàng', 100, 30,
 699000, 6990000, '["telegram","email","webhook","ssl","api","statuspage","priority"]', 40);
```

---

## 5. API Contract

All endpoints under `/api/*`. Responses: JSON. Auth via `Authorization: Bearer <access_token>` unless marked public.

### 5.1 Public endpoints (no auth)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/register` | `{email, password}` | 201 `{message}` |
| POST | `/api/auth/login` | `{email, password}` | 200 `{access_token, user}` + cookie |
| POST | `/api/auth/refresh` | — (cookie) | 200 `{access_token}` |
| POST | `/api/auth/logout` | — | 200 `{ok}` |
| POST | `/api/auth/forgot-password` | `{email}` | 200 (always, no enum) |
| POST | `/api/auth/reset-password` | `{token, new_password}` | 200 |
| GET | `/api/auth/verify-email` | `?token=` | redirect to dashboard |
| GET | `/api/plans` | — | 200 `[{slug,name,monitor_slots,price_monthly,...}]` |
| POST | `/api/webhook/pay2s` | Pay2S payload | 200 `{success:true}` |

### 5.2 User endpoints (JWT required)

**User profile & settings**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Profile + balance + subscription summary |
| PATCH | `/api/me` | Update profile (email cannot be changed without re-verify) |
| POST | `/api/me/change-password` | Old password required |
| POST | `/api/me/logout-all` | Revoke all sessions |
| GET | `/api/me/sessions` | List active sessions |

**Wallet**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/wallet/balance` | Current balance |
| GET | `/api/wallet/transactions?page=&type=&from=&to=` | Transaction history |
| GET | `/api/wallet/topup-info` | Returns bank accounts + memo format + VietQR URL |

**Subscriptions**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/subscriptions` | My subscriptions |
| POST | `/api/subscriptions/purchase` | Buy new (body: plan_id, cycle, discount_code?) |
| POST | `/api/subscriptions/:id/renew` | Manual renew now |
| POST | `/api/subscriptions/:id/toggle-auto-renew` | Toggle auto-renew |
| POST | `/api/subscriptions/:id/cancel` | Cancel (effective end of period) |
| POST | `/api/subscriptions/:id/upgrade` | Body: new_plan_id |

**Monitors**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/monitors` | My monitors list |
| POST | `/api/monitors` | Create (enforce plan quota) |
| GET | `/api/monitors/:id` | Details + recent checks |
| PATCH | `/api/monitors/:id` | Update config |
| DELETE | `/api/monitors/:id` | Delete |
| POST | `/api/monitors/:id/pause` | User-paused |
| POST | `/api/monitors/:id/resume` | Unpause |
| GET | `/api/monitors/:id/checks?range=24h|7d|30d` | Check history for chart |
| GET | `/api/monitors/:id/uptime?range=` | Uptime % |
| GET | `/api/monitors/:id/notifications` | Get prefs |
| PUT | `/api/monitors/:id/notifications` | Update prefs |

**Telegram**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/telegram/start-verify` | Returns 6-digit code + bot link |
| POST | `/api/telegram/confirm-verify` | Body: `{code, chat_id}` |
| DELETE | `/api/telegram/unlink` | Clear chat_id |

**Invoices**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/invoices` | My invoices |
| GET | `/api/invoices/:id` | Invoice detail |
| GET | `/api/invoices/:id/pdf` | Download PDF |

**Discounts (validation only, applied during purchase)**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/discounts/validate` | Body: `{code, plan_id, cycle}` → `{valid, discount_amount, reason?}` |

### 5.3 Admin endpoints (admin role required)

All admin endpoints write to `admin_audit_log`.

**User management**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/users?q=&page=` | Search users |
| GET | `/api/admin/users/:id` | User detail |
| PATCH | `/api/admin/users/:id` | Update (role, status) |
| POST | `/api/admin/users/:id/login-as` | Returns temp JWT (1h TTL) for CEO to act as user |
| POST | `/api/admin/users/:id/ban` | Body: `{reason}` |
| POST | `/api/admin/users/:id/balance-adjust` | Body: `{amount, reason}` — amount signed |
| GET | `/api/admin/users/:id/audit` | All audit log entries affecting this user |

**Plans**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/plans` | All plans including inactive |
| POST | `/api/admin/plans` | Create |
| PATCH | `/api/admin/plans/:id` | Update |
| DELETE | `/api/admin/plans/:id` | Soft delete (sets is_active=false) |

**Pay2S monitoring**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/pay2s/webhooks?status=&date=` | Webhook log |
| GET | `/api/admin/pay2s/unmatched` | Unmatched payments list |
| POST | `/api/admin/pay2s/unmatched/:id/resolve` | Body: `{user_id}` — credit to specified user |
| POST | `/api/admin/pay2s/reconcile-now` | Trigger reconciliation manually |

**Discounts**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/discounts` | List |
| POST | `/api/admin/discounts` | Create |
| PATCH | `/api/admin/discounts/:id` | Update |
| DELETE | `/api/admin/discounts/:id` | Delete |

**Dashboard & reports**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/dashboard` | MRR, new users, churn, pending topups |
| GET | `/api/admin/reports/revenue?from=&to=` | Revenue report |
| POST | `/api/admin/broadcast` | Body: `{title, message, channel: telegram/email, audience}` |

### 5.4 Response format (standardized)

**Success:**
```json
{ "data": { ... }, "meta": { "page": 1, "total": 100 } }
```

**Error:**
```json
{ "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Số dư không đủ để thực hiện giao dịch",
    "details": { "required": 89000, "available": 50000 }
} }
```

**Error codes (non-exhaustive):**
- `VALIDATION_FAILED` (400)
- `UNAUTHORIZED` (401), `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `INSUFFICIENT_BALANCE` (402)
- `RATE_LIMITED` (429)
- `INTERNAL` (500)

---

## 6. State Machines

### 6.1 `user_subscriptions.status`

```
                ┌─────────────────────┐
                │                     │
                │      PURCHASE       │
                │                     │
                └──────────┬──────────┘
                           ↓
                      ┌─────────┐
       ┌──auto_renew──│ active  │──user_cancel────→ cancelled
       │   success    │         │  (takes effect
       │              └────┬────┘   at period_end)
       │                   │
       │                   │ period_end reached
       │                   │ & insufficient balance
       │                   ↓
       │              ┌─────────┐
       │              │  grace  │  (3 days to top up)
       │              │         │
       │              └────┬────┘
       │         ┌─────────┴────────┐
       │         │                  │
       │  tops up│                  │ grace_period_end
       │  enough │                  │ reached
       │         ↓                  ↓
       │    (back to          ┌──────────┐
       └─── active)           │suspended │──admin──→ cancelled
                              │          │
                              └──────────┘
                                   │
                                   │ 90 days no payment
                                   ↓
                              ┌──────────┐
                              │ expired  │ (soft-deleted, not actually deleted)
                              └──────────┘
```

### 6.2 `monitors.status`

```
     unknown  ── first check ──→  up ⇄ down
                                  ↑     ↓ (triggers alert)
                                  │     │
                                  └─────┘
     
     Orthogonal flag: is_paused (boolean) — overrides above; skips checks.
```

### 6.3 `invoices.status`

```
    paid  ──admin refund──→  refunded
       │
       └──admin cancel (before subscription active)──→  cancelled
```

---

## 7. Background Jobs

All cron registered in `src/jobs/index.js`, dispatched by `vpsmmo-monitoring-cron` PM2 process.

| Job | Schedule | Purpose |
|---|---|---|
| `monitor-runner` | `* * * * *` (every minute) | Dispatch checks for due monitors |
| `alert-sender` | `*/30 * * * * *` (every 30s) | Drain pending alerts with retry |
| `email-sender` | `*/30 * * * * *` (every 30s) | Drain `email_queue` via Gmail SMTP |
| `billing-engine` | `5 0 * * *` (daily 00:05 VN) | Auto-renew due subscriptions |
| `pay2s-reconcile` | `15 * * * *` (hourly @ xx:15) | Pull Pay2S API, detect missed webhooks |
| `subscription-expire` | `10 0 * * *` (daily 00:10) | Transition expired subscriptions, pause monitors |
| `session-cleanup` | `0 3 * * *` (daily 03:00) | Delete expired sessions, reset tokens, telegram codes |
| `check-history-cleanup` | `0 4 * * *` (daily 04:00) | Delete `monitor_checks` older than 30 days |
| `ssl-expiry-check` | `0 8 * * *` (daily 08:00) | Scan SSL monitors, alert 30/14/7/3/1 days before expiry |

Every job uses this wrapper:

```js
async function runJob(name, fn) {
  const startTime = Date.now();
  log.info({ job: name }, 'job.start');
  try {
    await fn();
    log.info({ job: name, durationMs: Date.now()-startTime }, 'job.done');
  } catch (err) {
    log.error({ job: name, err }, 'job.failed');
    await telegram.sendToAdmin(`🚨 Job failed: ${name}\n${err.message}`);
  }
}
```

---

## 8. Email System (Gmail SMTP)

### 8.1 Why queue?

- Gmail SMTP limits: **500/day personal**, **2000/day Workspace**
- Sending inline in request handler = slow response + risk of quota burst
- Queue allows: retry, rate-throttling, priority, cancellation

### 8.2 Architecture

```
[Handler]
  ↓ enqueueEmail(to, subject, html, text, category, priority)
  ↓
[email_queue table] ─────────┐
                              │
                              ↓
           ┌──────────[email-sender cron, every 30s]
           │
           ├─ SELECT pending WHERE scheduled_at <= NOW
           │  ORDER BY priority ASC, scheduled_at ASC LIMIT 10
           │
           ├─ FOR EACH:
           │    - UPDATE status='sending' (claim via UPDATE WHERE id=? AND status='pending')
           │    - nodemailer send via Gmail SMTP
           │    - on success: UPDATE status='sent', sent_at=NOW
           │    - on fail: attempts++; if attempts<5 → reschedule (exponential backoff); else status='failed'
           │
           └─ Track daily quota: SELECT COUNT(*) WHERE status='sent' AND sent_at > today_start
              If >= 400 (safety margin below 500): ALERT admin, stop dispatching
```

### 8.3 Gmail SMTP config

```js
const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // STARTTLS
  auth: {
    user: process.env.SMTP_USER,         // full gmail address
    pass: process.env.SMTP_APP_PASSWORD  // 16-char app password, NOT main password
  },
  // Gmail rejects too many connections — reuse connection
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  rateDelta: 1000,
  rateLimit: 5 // max 5 emails per second
});
```

### 8.4 Required setup (document in BOOTSTRAP.md)

1. Enable 2FA on the Gmail account
2. Generate App Password at https://myaccount.google.com/apppasswords
3. Put in `.env`: `SMTP_USER=...@gmail.com`, `SMTP_APP_PASSWORD=xxxx xxxx xxxx xxxx`
4. Test with `POST /api/admin/email-test` before go-live

### 8.5 Email templates location

```
src/modules/email-templates/
├── verify-email.html
├── reset-password.html
├── topup-success.html
├── invoice.html              (with plan details + total)
├── renewal-reminder.html     (3 days before)
├── renewal-success.html
├── subscription-suspended.html
└── monitor-down-alert.html   (fallback if Telegram fails)
```

All templates use simple mustache-style `{{variable}}` interpolation. No external template engine beyond basic replace.

---

## 9. Security Layers

### 9.1 Defense in depth

```
Internet
   ↓
[Layer 1: Nginx]
  - HTTPS only (redirect 80→443)
  - Let's Encrypt auto-renew
  - Rate limit per IP (10 req/s general, 1 req/s on /auth/*)
  - Pay2S IP whitelist on /api/webhook/pay2s
  - X-Frame-Options: DENY, X-Content-Type-Options: nosniff
  - CSP headers
   ↓
[Layer 2: Express middleware]
  - CORS strict (only allow same origin)
  - helmet.js
  - Body size limit (100kb for most routes, 10kb for auth)
  - JWT verification
  - Admin role check (via admin-only middleware)
   ↓
[Layer 3: Business logic]
  - Ownership checks (user can only access their own data)
  - Idempotency for money operations
  - Input validation via zod
  - Parameterized SQL
   ↓
[Layer 4: DB]
  - Least-privilege DB user (no DROP, no admin)
  - Backup every 6h, retain 30 days
  - REPEATABLE READ isolation
```

### 9.2 Secrets management

- `.env` file, permission 600, owner node user only
- NEVER in git
- Backed up separately in encrypted vault (CEO's responsibility)
- Rotation: JWT secrets rotate every 6 months (token re-issue required)

### 9.3 PII handling

- Email stored plaintext (required for sending)
- Password: bcrypt cost 12 (never plaintext, never reversibly encrypted)
- IP addresses stored for security audit (session, audit log) — considered PII, 90-day retention
- No user phone, no address collected in MVP

---

## 10. Deployment Topology

### 10.1 Single VPS layout

```
VPS 103.77.242.145 (AlmaLinux 9)
├── /etc/nginx/conf.d/monitoring.vpsmmo.vn.conf
├── /var/log/nginx/monitoring.*.log
├── /root/vpsmmo-monitoring/                  ← git repo
│   ├── src/
│   ├── .env                                   (600 perm, root:root)
│   ├── package.json
│   └── ecosystem.config.js
├── /var/log/vpsmmo-monitoring/               ← pino logs
│   ├── app.log
│   ├── cron.log
│   └── checker.log
├── /var/lib/vpsmmo-monitoring/invoices/      ← PDF storage
└── MySQL 8.0
    └── database: vpsmmo_monitoring
        user: vpsmmo_monitoring (not root)
```

### 10.2 PM2 ecosystem

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'vpsmmo-monitoring-web',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      error_file: '/var/log/vpsmmo-monitoring/app.err.log',
      out_file: '/var/log/vpsmmo-monitoring/app.out.log',
      env_production: { NODE_ENV: 'production', ROLE: 'web' }
    },
    {
      name: 'vpsmmo-monitoring-cron',
      script: 'src/cron-runner.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      env_production: { NODE_ENV: 'production', ROLE: 'cron' }
    },
    {
      name: 'vpsmmo-monitoring-checker',
      script: 'src/checker-runner.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env_production: { NODE_ENV: 'production', ROLE: 'checker' }
    }
  ]
};
```

### 10.3 Nginx config skeleton

```nginx
server {
  listen 80;
  server_name monitoring.vpsmmo.vn;
  return 301 https://$server_name$request_uri;
}

server {
  listen 443 ssl http2;
  server_name monitoring.vpsmmo.vn;

  ssl_certificate     /etc/letsencrypt/live/monitoring.vpsmmo.vn/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/monitoring.vpsmmo.vn/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;

  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Strict-Transport-Security "max-age=31536000" always;

  limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
  limit_req_zone $binary_remote_addr zone=auth:10m rate=2r/s;

  # Pay2S webhook IP whitelist (TBD — get from Pay2S support)
  location = /api/webhook/pay2s {
    # allow <PAY2S_IP_1>;
    # allow <PAY2S_IP_2>;
    # deny all;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /api/auth/ {
    limit_req zone=auth burst=5 nodelay;
    proxy_pass http://127.0.0.1:3000;
  }

  location / {
    limit_req zone=general burst=20 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

---

## 11. Observability

### 11.1 Logging (pino)

- All logs JSON format, written to `/var/log/vpsmmo-monitoring/app.log`
- Rotate via `logrotate` daily, keep 30 days compressed
- Log levels: `error`, `warn`, `info`, `debug`
- Production: `info` default
- Every request logs: method, path, status, duration, userId (if auth)

### 11.2 Critical events → Telegram admin

These events trigger immediate Telegram alert to admin:

- Pay2S webhook signature failure (possible attack)
- Unmatched payment received
- Email queue quota approaching limit (80% of daily limit)
- Cron job failure (any)
- 5xx error rate > 1% over 5 minutes
- DB connection pool exhaustion
- Disk > 80% full

### 11.3 Health check endpoint

`GET /health` returns:
```json
{
  "status": "ok",
  "uptime_sec": 12345,
  "db": "ok",
  "email_queue_pending": 3,
  "webhook_pending": 0,
  "version": "1.0.0"
}
```

Used by: Nginx upstream check, external uptime monitor (inception — monitor.vpsmmo.vn can watch this).

---

## 12. Open questions / deferred decisions

These are NOT for Claude Code to decide. Flag to human when encountered.

- **Pay2S IP ranges** — ask Pay2S support. Until then, Nginx IP whitelist is disabled (TBD in production).
- **Bank account numbers to accept** — CEO provides via `.env` `PAY2S_BANK_ACCOUNTS`.
- **Invoice numbering reset policy** — reset yearly or continuous? CEO decision. Default: continuous.
- **Billing tax info** — tax ID format, company invoice template. Defer to Phase 2.
- **Frontend framework** — EJS in MVP. React SPA revisited post-launch based on UX feedback.

---

## 13. Diagrams directory (Phase 7+)

When code starts, produce Mermaid diagrams in `docs/diagrams/` for:

- ER diagram of final schema
- Sequence diagram of Pay2S webhook
- Sequence diagram of purchase flow
- State machine of subscription lifecycle

These are documentation deliverables, generated last — not blockers.

— End of ARCHITECTURE.md —

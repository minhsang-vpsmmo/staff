# MILESTONES.md — VPSMMO Monitoring Implementation Roadmap

> This file defines the EXECUTION ORDER of the project. Each phase has prerequisites, deliverables, and acceptance criteria.
> YOU (Claude Code) MUST complete phases in order. A phase is NOT done until ALL acceptance criteria pass.
> When a phase is done, STOP and report. Wait for human approval before starting the next phase.

---

## 🎯 How to work with this file

1. Before starting a phase: re-read its section + relevant parts of CLAUDE.md & ARCHITECTURE.md.
2. State your implementation plan BEFORE coding. Wait for human approval.
3. Implement with tests.
4. Tick every item in the "Acceptance Criteria" section.
5. Run "Verification Commands" — all must pass.
6. Report using the template in §Phase Completion Report.
7. STOP. Wait for human to say "continue to Phase N+1".

**Rule:** Never skip ahead. Never merge phases. Never claim done with incomplete criteria.

---

## 🗺️ Overview — 8 Phases

| # | Phase | Focus | Est. effort |
|---|---|---|---|
| 1 | Foundation | Project scaffold, DB, env, logging, CI-ready | 1-2 days |
| 2 | Auth | Register, login, sessions, email verify, password reset | 2-3 days |
| 3 | Wallet Core | Balance, transactions, primitives (credit/debit), admin adjust | 2 days |
| 4 | Pay2S Integration | Webhook receiver, reconciliation, unmatched handling | 2-3 days |
| 5 | Plans & Subscriptions | Plan CRUD, purchase, cancel, upgrade, invoices, discounts | 3-4 days |
| 6 | Billing Engine | Cron auto-renewal, grace period, suspension, expire handling | 2 days |
| 7 | Monitoring Core | HTTP/Ping/TCP/SSL/DNS/Keyword checks, alerts, dedup, prefs | 3-4 days |
| 8 | Frontend + Admin | EJS views, user dashboard, admin panel | 4-5 days |
| 9 | Adversarial Audit | Self-attack, penetration test, fix findings | 2 days |
| 10 | Production Hardening | Nginx, SSL, systemd, backup, monitoring of self | 1-2 days |

**Total: ~22-30 working days.**

Phases 9 and 10 are post-implementation validation. They are MANDATORY before public launch.

---

## ✅ Phase Completion Report (template)

At the end of each phase, produce this exact report:

```
## ✅ Phase N complete: <name>

### What I built
- <file path>: <what it does>
- ... (every meaningful file)

### Migrations applied
- migrations/NNN_name.sql: <summary>

### Tests
- Unit: X passed / Y total (Z% coverage on this phase's code)
- Integration: X passed / Y total
- Money-path branch coverage: 100% / NOT APPLICABLE

### Acceptance criteria (§Phase N)
- [x] item 1
- [x] item 2
- [ ] item 3 — reason: <explain, seek human input if blocker>

### Verification commands output
<paste stdout of each verification command>

### Security checklist items addressed
- SEC-XX: <brief>
- SEC-YY: <brief>

### Known issues / deferred items
- <any TODO or future-phase work noted>

### Blockers for next phase
- <list anything that needs human input>

### Ready for Phase N+1?
- YES / NO (with explanation)
```

Do not proceed without human reply.

---

# Phase 1 — Foundation

**Goal:** Empty-to-runnable scaffold. No business logic yet. Everything afterwards relies on this.

### Prerequisites
- VPS 103.77.242.145 accessible
- Git repo initialized (human has set up GitHub private repo)
- MySQL 8.0+ installed, `vpsmmo_monitoring` database created
- Node.js 20 LTS installed
- PM2 installed globally
- All 5 context files present in repo root (CLAUDE.md, ARCHITECTURE.md, MILESTONES.md, SECURITY-CHECKLIST.md, ADVERSARIAL-TESTING.md)

### Deliverables

1. **Project init**
   - `package.json` with all approved deps from CLAUDE.md §5.2
   - `.nvmrc` pinning Node 20
   - `.gitignore` covering: `node_modules/`, `.env`, `.env.local`, `*.log`, `/var/log/*`, `dist/`, `coverage/`, `*.pem`, `*.key`, `id_rsa*`, `invoices/*.pdf`
   - `.env.example` matching CLAUDE.md §13 exactly
   - `README.md` with: quick start, env vars, scripts, links to CLAUDE.md
   - `.gitattributes` for line endings

2. **Git hooks** (`.git-hooks/pre-commit`)
   - Scan staged files for: `AIzaSy`, `sk_live_`, `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`, `-----BEGIN OPENSSH`, patterns matching JWT-like strings, `smtp_app_password=`, raw `.env` attempts
   - Scan for `console.log(` in src/ (warning not blocking)
   - Reject commit with non-zero exit if secrets found
   - Script to install: `scripts/install-hooks.sh` copies to `.git/hooks/`

3. **Folder skeleton** (empty directories with `.gitkeep`)
   - Per CLAUDE.md §4 exactly

4. **Environment validation** (`src/config/env.js`)
   - zod schema for all env vars
   - Process exits with code 1 if required vars missing, printing exactly which
   - Distinguish dev vs production: dev allows some missing (e.g. Pay2S)
   - No defaults for secrets; only defaults for non-secret ops vars (PORT=3000, LOG_LEVEL=info)

5. **Database connection** (`src/config/db.js`)
   - `mysql2/promise` pool
   - Pool size: 20 prod, 5 dev
   - `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` on connection acquire
   - Health check function `db.ping()` returns boolean
   - Graceful shutdown on SIGTERM

6. **Logger** (`src/lib/logger.js`)
   - Pino configured per env (pretty dev, JSON prod)
   - Log file at `/var/log/vpsmmo-monitoring/app.log` in prod
   - Helper: `logger.child({ module: 'wallet' })` pattern
   - Redaction config for secret paths: `password`, `token`, `authorization`, `secret`

7. **Error classes** (`src/lib/errors.js`)
   - `AppError(code, message, status, details)`
   - `ValidationError`, `AuthError`, `ForbiddenError`, `NotFoundError`, `InsufficientBalanceError`, `RateLimitError`
   - All serialize to CLAUDE.md §5.4 shape

8. **Error middleware** (`src/middleware/error-handler.js`)
   - Catches AppError → proper status + JSON
   - Catches zod errors → 400 + validation details
   - Catches everything else → 500 + log with stack, hide details in prod

9. **Money lib** (`src/lib/money.js`)
   - Wrapper around `decimal.js`
   - `toVND(x)` / `fromVND(x)` / `add(a,b)` / `sub(a,b)` / `gte(a,b)` / `format(x)` (Vietnamese format: 1.234.567 ₫)
   - NEVER accepts or returns JS `Number` for VND values
   - All ops return `Decimal` instances
   - Comprehensive unit tests (see §1 tests below)

10. **Basic HTTP server** (`src/server.js`)
    - Express app
    - Middleware: helmet, cors strict, json body limit 100kb
    - `GET /health` returns `{status:"ok", uptime_sec, db: "ok"|"fail"}`
    - `GET /` returns `{name:"VPSMMO Monitoring API", version}`
    - Graceful shutdown: drain inflight requests, close DB pool, exit 0 on SIGTERM

11. **Constants** (`src/config/constants.js`)
    - `MIN_TOPUP_VND = 10000`
    - `JWT_ACCESS_TTL_SEC = 900`
    - `JWT_REFRESH_TTL_SEC = 2592000`
    - `LOGIN_MAX_ATTEMPTS = 5`
    - `LOGIN_LOCKOUT_MIN = 15`
    - `EMAIL_DAILY_HARD_CAP = 450`
    - `EMAIL_DAILY_WARN_CAP = 320`
    - `ALERT_DEDUP_WINDOW_MIN = 5`
    - `GRACE_PERIOD_DAYS = 3`
    - `MONITOR_CHECK_TIMEOUT_DEFAULT_SEC = 30`
    - `MONITOR_CHECK_HISTORY_RETENTION_DAYS = 30`
    - All other magic numbers extracted here

12. **First migration** (`migrations/001_initial_schema.sql`)
    - Combined schema from CLAUDE.md §3 + ARCHITECTURE.md §4.2
    - Idempotent (uses `IF NOT EXISTS`)
    - Includes seed data from ARCHITECTURE.md §4.3

13. **Migration runner** (`scripts/migrate.js`)
    - Reads `migrations/` dir, tracks applied in `_migrations` table
    - Command: `node scripts/migrate.js up` / `node scripts/migrate.js status`
    - REFUSES to run if NODE_ENV=production without env flag `ALLOW_PROD_MIGRATE=1`
    - Human must run manually in production; Claude only writes the files

14. **PM2 config** (`ecosystem.config.js`) per ARCHITECTURE.md §10.2 (web only; cron/checker placeholders for later phases)

15. **Tests**
    - `tests/unit/money.test.js`: full coverage of money.js
    - `tests/unit/errors.test.js`: error serialization
    - `tests/integration/health.test.js`: GET /health returns expected shape
    - `tests/integration/env-validation.test.js`: missing vars cause boot fail
    - `vitest.config.js` configured

### Acceptance Criteria (Phase 1)

- [ ] `node src/server.js` starts successfully with valid `.env`
- [ ] `node src/server.js` exits with code 1 and clear error when any required env missing
- [ ] `curl http://localhost:3000/health` returns `{status:"ok", db:"ok"}`
- [ ] `node scripts/migrate.js up` applies 001 migration cleanly on fresh DB
- [ ] Re-running `migrate.js up` is idempotent (no errors, no duplicate tables)
- [ ] `npm test` all green
- [ ] `money.js` unit tests include: `0.1 + 0.2 === 0.3`, large-number precision, format output
- [ ] Pre-commit hook rejects commit containing `"password":"actualvalue"`
- [ ] `.env` does NOT appear in `git status`
- [ ] All files have correct permissions (.env = 600)
- [ ] PM2 can start `vpsmmo-monitoring-web` via `pm2 start ecosystem.config.js`
- [ ] Logger writes to file in production config, pretty to console in dev
- [ ] Database pool recovers from transient disconnect (simulate: kill MySQL, wait, restart)

### Verification Commands

```bash
# 1. Boot succeeds
node src/server.js & sleep 2 && curl -sf http://localhost:3000/health && pkill -f "src/server.js"

# 2. Missing env detected
DB_PASSWORD= node src/server.js 2>&1 | grep -i "DB_PASSWORD"

# 3. Migration idempotent
node scripts/migrate.js up
node scripts/migrate.js up  # should say "nothing to apply"

# 4. Test suite
npm test

# 5. Pre-commit hook
echo 'const secret = "sk_live_abc123";' > /tmp/fake-secret.js
git add /tmp/fake-secret.js 2>&1  # should fail or warn
rm /tmp/fake-secret.js

# 6. PM2
pm2 start ecosystem.config.js && sleep 2 && pm2 list && pm2 stop vpsmmo-monitoring-web
```

### What NOT to do in Phase 1

- NO authentication code
- NO wallet code
- NO Pay2S code
- NO business endpoints
- NO frontend views

Phase 1 is infrastructure only.

---

# Phase 2 — Authentication

**Goal:** Users can register, verify email, log in, stay logged in via refresh tokens, reset password, log out (incl. all devices).

### Prerequisites
- Phase 1 complete and merged to `dev` branch
- `email_queue` table exists (from migration 001)
- Gmail SMTP credentials in `.env`

### Deliverables

1. **Modules** (`src/modules/auth/`)
   - `register.js`: POST /api/auth/register
   - `login.js`: POST /api/auth/login
   - `refresh.js`: POST /api/auth/refresh
   - `logout.js`: POST /api/auth/logout
   - `logout-all.js`: POST /api/me/logout-all
   - `verify-email.js`: GET /api/auth/verify-email
   - `forgot-password.js`: POST /api/auth/forgot-password
   - `reset-password.js`: POST /api/auth/reset-password
   - `change-password.js`: POST /api/me/change-password
   - `service.js`: shared primitives (hash, verify, issue tokens)
   - `routes.js`: mount all

2. **JWT management** (`src/lib/jwt.js`)
   - `issueAccess(user)` → 15min JWT
   - `issueRefresh()` → random 32-byte base64url, stored hashed in `user_sessions`
   - `verifyAccess(token)` → { userId, role } or throw
   - `rotateRefresh(oldToken)` → revoke old, issue new, return pair
   - Uses separate secrets for access vs refresh

3. **Middleware** (`src/middleware/auth.js`)
   - `requireAuth`: verify JWT, attach `req.user = {id, email, role}`
   - `requireAdmin`: requireAuth + check role in ('admin','superadmin')
   - On expired access: 401 with `{error:{code:'TOKEN_EXPIRED'}}` (so frontend knows to refresh)

4. **Rate limiting** (`src/middleware/rate-limit.js`)
   - MySQL-backed via `rate_limit_buckets` table (sliding window, 10-min windows)
   - Preset configs: `auth` (5/5min), `general` (100/min), `webhook` (unlimited — IP whitelisted at Nginx)
   - Applied per route in routes.js

5. **Email templates** (`src/modules/email-templates/`)
   - `verify-email.html` + `.txt`: welcome + click link
   - `reset-password.html` + `.txt`: click link, 1h expiry
   - Subject lines in Vietnamese, body bilingual (VN primary, EN fallback)

6. **Email sender cron job** (`src/jobs/email-sender.js`)
   - Per ARCHITECTURE.md §8.2
   - Gmail SMTP pool per §8.3
   - Honors `EMAIL_DAILY_HARD_CAP`; alerts admin Telegram at `WARN_CAP`
   - Retry with exp backoff, max 5 attempts

7. **Telegram lib** (`src/lib/telegram.js`)
   - `sendMessage(chatId, text, opts)` with HTML parse mode
   - `sendToAdmin(text)` uses `TELEGRAM_ADMIN_CHAT_ID`
   - Swallows errors but logs them; never crashes caller

### Acceptance Criteria (Phase 2)

- [ ] Register with valid input → 201, row in `users`, email queued in `email_queue`
- [ ] Register with duplicate email → 400 with code `EMAIL_TAKEN` (case-insensitive check)
- [ ] Register with weak password (< 8 chars) → 400 with validation details
- [ ] Password hash stored as bcrypt with cost 12 (verifiable: `$2b$12$...`)
- [ ] Clicking verify link sets `users.email_verified = true` and clears token
- [ ] Expired verify token → user-friendly error page / JSON error
- [ ] Login with unverified email → 403 `EMAIL_NOT_VERIFIED` (configurable: allow unverified login in dev)
- [ ] Login success: receive access token in body, refresh token in httpOnly secure cookie
- [ ] 5 failed logins → account locked for 15 minutes → 429 with `locked_until` info
- [ ] Successful login resets `failed_login_count`
- [ ] Refresh endpoint: valid refresh → new access + rotated refresh; old refresh invalidated
- [ ] Logout revokes session (refresh token invalid after)
- [ ] Logout-all revokes ALL sessions for user
- [ ] Forgot password: always returns 200 (no email enumeration)
- [ ] Forgot password: only sends email if user exists
- [ ] Reset token single-use; expired after 1 hour
- [ ] Change password requires old password
- [ ] Change password invalidates all other sessions except current
- [ ] Email sender cron drains queue in < 30s under normal load
- [ ] Email at 320/day sent triggers Telegram warning to admin
- [ ] Email at 450/day stops sending new emails (queue paused)

### Money-path impact: NONE

This phase does not touch `users.balance`. No money-path protocol needed.

### Verification Commands

```bash
# Register
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"strongP@ss123"}'

# Email queued
mysql vpsmmo_monitoring -e "SELECT to_email, status FROM email_queue ORDER BY id DESC LIMIT 1"

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"strongP@ss123"}' \
  -c /tmp/cookies.txt

# Refresh
curl -X POST http://localhost:3000/api/auth/refresh -b /tmp/cookies.txt

# Brute force lockout (should lock after 5)
for i in 1 2 3 4 5 6; do
  curl -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}' \
    -w "\nHTTP %{http_code}\n"
done

# Test suite
npm test -- auth
```

---

# Phase 3 — Wallet Core

**Goal:** Bulletproof money primitives. Balance read, transaction history, internal `credit()` / `debit()` functions with idempotency and row locks. Admin balance adjustment endpoint.

### Prerequisites
- Phase 2 complete (auth works, admin user exists in DB)
- `wallet_transactions` and `admin_audit_log` tables exist

### Deliverables

1. **Wallet service** (`src/modules/wallet/service.js`)
   - `credit(userId, amount, opts)` — returns `{duplicate, transactionId, balanceAfter}`
   - `debit(userId, amount, opts)` — returns same OR throws `InsufficientBalanceError`
   - `getBalance(userId)` — read uncommitted OK? NO: use consistent read from users table
   - `getTransactions(userId, {page,type,from,to})` — paginated
   - Internal-only (no HTTP exposure for credit/debit directly)
   - Follows Pattern A from CLAUDE.md §6.1 EXACTLY

2. **HTTP endpoints** (`src/modules/wallet/routes.js`)
   - `GET /api/wallet/balance` → `{balance, formatted}`
   - `GET /api/wallet/transactions?page=&type=&from=&to=` → paginated list
   - `GET /api/wallet/topup-info` → bank info + memo format + VietQR URL

3. **VietQR** (`src/lib/vietqr.js`)
   - Generate URL for VietQR image (use vietqr.io public API)
   - Memo = `VPSMMO<user_id>`
   - Bank account from `PAY2S_BANK_ACCOUNTS` env (first one in list as primary)
   - Returns image URL; frontend embeds

4. **Admin balance adjustment** (`src/modules/admin/balance-adjust.js`)
   - `POST /api/admin/users/:id/balance-adjust`
   - Body: `{amount, reason}` (amount signed, reason required ≥ 10 chars)
   - Wraps `wallet.credit` or `wallet.debit` with `type='admin_adjust'`
   - Writes to `admin_audit_log`
   - Refuses if reason empty or suspiciously short

5. **Tests** — MUST include adversarial cases
   - Unit tests for `money.js` edge cases (already in Phase 1, expand)
   - Integration: concurrent credit test (10 parallel credits, verify final balance)
   - Integration: concurrent debit test (insufficient balance race)
   - Integration: idempotency — same key called twice, only one txn
   - Integration: `SUM(wallet_transactions.amount WHERE user_id=X) === users.balance` after 100 random operations
   - Integration: debit below zero MUST throw, not silently zero balance

### Money-path coverage requirement: 100%

Every line and branch of `wallet/service.js` must be covered. Run `npm test -- --coverage` and verify.

### Acceptance Criteria (Phase 3)

- [ ] `credit()` writes `wallet_transactions` row BEFORE updating `users.balance`
- [ ] `credit()` uses `SELECT ... FOR UPDATE` on user row
- [ ] `credit()` with duplicate `idempotencyKey` returns `{duplicate:true}` without double-crediting
- [ ] `debit()` throws `InsufficientBalanceError` when balance too low; NO partial debit
- [ ] `debit()` with negative amount throws (defensive)
- [ ] All wallet ops in single DB transaction (verify via BEGIN/COMMIT trace)
- [ ] `balance_before` + `amount` === `balance_after` for every transaction row
- [ ] Concurrent credit test: 10 parallel +10k calls → final balance exactly +100k
- [ ] Admin balance adjust with empty reason → 400
- [ ] Admin balance adjust writes `admin_audit_log` row in same transaction
- [ ] Non-admin calling admin endpoint → 403
- [ ] `GET /api/wallet/transactions` paginates correctly, doesn't leak other users' data
- [ ] `GET /api/wallet/topup-info` returns valid VietQR URL for user's memo
- [ ] Stress test: 100 random credit/debit ops → DB balance == sum of transactions (invariant)

### Verification Commands

```bash
# Balance invariant check (run after stress test)
mysql vpsmmo_monitoring -e "
  SELECT u.id, u.balance, 
         COALESCE(SUM(wt.amount), 0) AS txn_sum,
         u.balance - COALESCE(SUM(wt.amount), 0) AS diff
  FROM users u LEFT JOIN wallet_transactions wt ON u.id = wt.user_id
  GROUP BY u.id HAVING diff != 0;
"
# Expected: 0 rows

# Coverage
npm test -- --coverage src/modules/wallet/
# Expected: 100% on service.js

# Concurrent test
npm test -- wallet-concurrent
```

### STOP — Human approval required before Phase 4

Phase 3 is the foundation of everything financial. Do NOT proceed to Pay2S until human has verified:
- Reviewed `wallet/service.js` code
- Run the invariant check manually
- Approved with written "go phase 4"

---

# Phase 4 — Pay2S Integration

**Goal:** Incoming webhooks credit wallets correctly, idempotently, safely. Unmatched payments captured. Hourly reconciliation detects missed webhooks.

### Prerequisites
- Phase 3 complete; wallet primitives proven
- Human has provided `.env` values:
  - `PAY2S_WEBHOOK_SECRET`
  - `PAY2S_API_TOKEN`
  - `PAY2S_BANK_ACCOUNTS` (csv of bank account numbers)
  - `PAY2S_ALLOWED_IPS` (optional)

### Deliverables

1. **Webhook receiver** (`src/modules/pay2s/webhook.js`)
   - `POST /api/webhook/pay2s`
   - Follows ARCHITECTURE.md §3.3 flow EXACTLY
   - Uses timingSafeEqual for Bearer compare
   - Raw body preserved for audit

2. **Memo parser** (`src/modules/pay2s/memo-parser.js`)
   - Regex: `/VPSMMO(\d+)|NAP(\d+)/i`
   - Returns `{userId: number}` or `null`
   - Handles mixed case, extra spaces
   - Unit tested with real Pay2S content samples from fixtures

3. **Unmatched payment handler** (`src/modules/pay2s/unmatched.js`)
   - Insert into `unmatched_payments`
   - Alert admin via Telegram with: amount, content, gateway, time
   - Provide admin resolve endpoint: `POST /api/admin/pay2s/unmatched/:id/resolve {user_id}`
   - Resolve credits user + marks payment resolved + writes audit log

4. **Reconciliation job** (`src/jobs/pay2s-reconcile.js`)
   - Schedule: hourly (per ARCHITECTURE.md §7)
   - Calls Pay2S history API
   - For each txn: check `pay2s_webhooks.checksum` exists
   - If missing: treat as new webhook (same flow), log "recovered via reconciliation"
   - Rate limit aware (60 req/min cap)
   - Writes audit of each reconciliation run

5. **Admin views** (`src/modules/admin/pay2s.js`)
   - `GET /api/admin/pay2s/webhooks?status=&date=` — paginated webhook log
   - `GET /api/admin/pay2s/unmatched` — pending unmatched
   - `POST /api/admin/pay2s/unmatched/:id/resolve` — credit to specified user
   - `POST /api/admin/pay2s/reconcile-now` — trigger reconciliation manually

6. **Test fixtures** (`tests/fixtures/pay2s-webhook-samples.json`)
   - Real-shaped payloads:
     - Valid IN to ACB with correct memo
     - Valid IN with NAP format memo (backward compat)
     - Valid IN with unparseable memo
     - OUT transaction (should be ignored)
     - Batch of 3 transactions
     - Duplicate checksum (replay)
     - Amount below minimum
     - User not found
     - User banned

### Acceptance Criteria (Phase 4)

- [ ] Webhook with missing Authorization → 401
- [ ] Webhook with wrong Bearer → 401
- [ ] Webhook with correct Bearer but wrong body shape → 400
- [ ] Valid webhook inserts `pay2s_webhooks` row BEFORE any credit
- [ ] Duplicate checksum: second call does NOT credit again; responds 200 anyway
- [ ] IN transaction with matching memo: user credited, `processed=true`, notifications queued
- [ ] IN transaction below MIN_TOPUP_VND: logged, marked processed with reason, NOT credited
- [ ] OUT transaction: logged, marked processed, NOT credited
- [ ] Unparseable memo: inserted into `unmatched_payments`, admin alerted, NOT credited
- [ ] User not found: same as unparseable
- [ ] Banned user: same as unparseable
- [ ] Webhook ALWAYS responds `{success:true}` with HTTP 200 (even on internal failures)
- [ ] Concurrent duplicate webhooks: exactly ONE credit (race-safe via UNIQUE constraint)
- [ ] Reconciliation: run against DB missing 3 webhook entries → 3 recoveries logged
- [ ] Reconciliation: re-run same window → no duplicates
- [ ] Admin resolve unmatched: credits correct user + audit log + marks resolved
- [ ] Admin resolve unmatched: cannot resolve twice (status enforced)
- [ ] All webhooks regardless of outcome appear in `GET /api/admin/pay2s/webhooks`
- [ ] Load test: 100 webhooks posted in 10s → all processed correctly, no DB deadlocks

### Money-path coverage: 100%

### Verification Commands

```bash
# Valid webhook (use sample fixture)
curl -X POST http://localhost:3000/api/webhook/pay2s \
  -H "Authorization: Bearer $PAY2S_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/pay2s-webhook-samples.json

# Replay same payload
curl -X POST http://localhost:3000/api/webhook/pay2s \
  -H "Authorization: Bearer $PAY2S_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/pay2s-webhook-samples.json
# Should return success but not double-credit (verify DB)

# Invariant still holds
mysql vpsmmo_monitoring -e "<same as Phase 3 invariant check>"

# Reconciliation
node -e "require('./src/jobs/pay2s-reconcile').run()"
```

### STOP — Human approval required before Phase 5

This is the second-most-critical piece (after wallet core). Human must:
- Review `webhook.js` code line-by-line
- Verify on actual Pay2S sandbox if available
- Run replay test manually
- Approve with written "go phase 5"

---

# Phase 5 — Plans & Subscriptions

**Goal:** Users can browse plans, apply discount codes, purchase subscriptions (monthly/yearly), receive invoices, upgrade/downgrade, cancel.

### Prerequisites
- Phase 4 complete
- Seed plans present from migration
- `invoices`, `discount_codes`, `discount_code_usages` tables exist

### Deliverables

1. **Plans module** (`src/modules/plans/`)
   - `routes.js`: `GET /api/plans` (public), admin CRUD at `/api/admin/plans`
   - `service.js`: plan lookup, display ordering
   - Admin edit: never delete plans with active subscriptions; soft-delete (is_active=false)

2. **Subscriptions module** (`src/modules/subscriptions/`)
   - `purchase.js`: POST /api/subscriptions/purchase (follows ARCHITECTURE.md §3.4 exactly)
   - `renew.js`: POST /api/subscriptions/:id/renew (manual)
   - `toggle-auto-renew.js`: POST /api/subscriptions/:id/toggle-auto-renew
   - `cancel.js`: POST /api/subscriptions/:id/cancel (effective end of period)
   - `upgrade.js`: POST /api/subscriptions/:id/upgrade (prorated credit for unused)
   - `list.js`: GET /api/subscriptions (user's list)
   - `service.js`: state machine enforcement

3. **Invoices module** (`src/modules/invoices/`)
   - Invoice number generator: `INV-YYYYMM-NNNNNN` (atomic counter via MySQL row lock)
   - `generator.js`: create invoice record
   - `pdf.js`: render PDF via pdfkit (Vietnamese fonts, logo, table)
   - `routes.js`: `GET /api/invoices`, `GET /api/invoices/:id`, `GET /api/invoices/:id/pdf`

4. **Discounts module** (`src/modules/discounts/`)
   - `validate.js`: POST /api/discounts/validate — returns usable-or-not + reason
   - `apply.js`: internal, called during purchase
   - `service.js`: usage count increment (race-safe), per-user limit enforcement
   - Admin: `GET/POST/PATCH/DELETE /api/admin/discounts`

5. **Upgrade/downgrade logic**
   - Upgrade (Pro → Business mid-month):
     - Calculate unused portion of current plan as credit: `(remaining_days / total_days) * current_plan_price`
     - Charge: `new_plan_price - credit`
     - End current subscription
     - Create new subscription with period_end = same as old (billing aligned)
   - Downgrade: takes effect at end of current period (simpler, avoids refund complexity)

### Acceptance Criteria (Phase 5)

- [ ] `GET /api/plans` returns only active plans, ordered by display_order
- [ ] Purchase with insufficient balance → 402 `INSUFFICIENT_BALANCE` with details
- [ ] Purchase success: invoice created, wallet debited, subscription active
- [ ] Purchase with valid discount: final total = subtotal - discount
- [ ] Purchase with invalid discount: 400 with specific reason (expired/used-up/wrong-plan)
- [ ] Discount code usage_count increments atomically (concurrent test)
- [ ] Per-user discount limit enforced (user can't apply same code twice if limit=1)
- [ ] Invoice number format: INV-YYYYMM-NNNNNN, sequential, no gaps
- [ ] PDF renders with: invoice number, plan name, period, price, total, user email, date
- [ ] Manual renewal: only allowed when status='active', deducts balance, extends period
- [ ] Manual renewal: idempotency key `renewal:${sub_id}:${old_period_end}` prevents double-charge
- [ ] Toggle auto-renew: boolean flip, no money movement
- [ ] Cancel subscription: `cancelled_at` set, `auto_renew=false`, status still 'active' until period end
- [ ] Cancelled subscription doesn't renew in billing engine
- [ ] Upgrade: old subscription marked cancelled, new one created, correct prorated charge
- [ ] Upgrade: total credits + debits = net cost (invariant)
- [ ] Downgrade: scheduled; takes effect at next billing cycle
- [ ] Ownership: user cannot access another user's subscription
- [ ] Admin can see all subscriptions via admin endpoint

### Money-path coverage: 100%

### Verification Commands

```bash
# Purchase
curl -X POST http://localhost:3000/api/subscriptions/purchase \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan_id":2,"billing_cycle":"monthly"}'

# Verify invoice + wallet
mysql vpsmmo_monitoring -e "
  SELECT i.id, i.total, wt.amount, u.balance 
  FROM invoices i 
  JOIN wallet_transactions wt ON i.wallet_transaction_id = wt.id 
  JOIN users u ON i.user_id = u.id
  WHERE u.id = <test_user_id>
  ORDER BY i.id DESC LIMIT 1;
"

# Invariant
npm test -- invariants
```

---

# Phase 6 — Billing Engine

**Goal:** Automatic subscription renewal from wallet. Grace period. Suspension. Monitor auto-pause on expiry. Reminder emails.

### Prerequisites
- Phase 5 complete
- `vpsmmo-monitoring-cron` PM2 process can be started

### Deliverables

1. **Billing engine** (`src/jobs/billing-engine.js`)
   - Follows ARCHITECTURE.md §3.5 logic EXACTLY
   - Schedule: `5 0 * * *` (daily 00:05 Asia/Ho_Chi_Minh)
   - Idempotency: key pattern `renewal:${sub_id}:${current_period_end}`
   - Handles: active auto-renew, active+insufficient, grace, grace+sufficient, grace expired

2. **Subscription expire job** (`src/jobs/subscription-expire.js`)
   - Schedule: daily 00:10
   - Pauses monitors under suspended/expired subscriptions
   - Sets pause_reason='subscription_expired'
   - Sends notification "Dịch vụ tạm ngưng"

3. **Reminder system** (`src/modules/subscriptions/reminders.js`)
   - 7 days before expiry: reminder (once)
   - 3 days before expiry + insufficient balance: urgent reminder (once)
   - 1 day before expiry: final reminder
   - Uses flags on subscription table OR separate `sent_reminders` cache to avoid spam

4. **Cron runner** (`src/cron-runner.js`)
   - Entry point for `vpsmmo-monitoring-cron` PM2 process
   - Registers all cron jobs via node-cron
   - Each job wrapped with runJob helper (ARCHITECTURE.md §7)

### Acceptance Criteria (Phase 6)

- [ ] Subscription with `auto_renew=true` and sufficient balance: renewed, period extended, balance deducted, invoice created
- [ ] Subscription with insufficient balance: moves to `grace` status, `grace_period_end = period_end + 3 days`
- [ ] User tops up during grace period: next billing cron day renews successfully
- [ ] Grace period expires without topup: status → `suspended`, monitors paused
- [ ] Cancelled subscription: NOT renewed
- [ ] Renewing same subscription twice same day: idempotency key blocks double-charge
- [ ] Cron restart mid-run: resumes safely, no double-charges
- [ ] Monitors: `pause_reason='subscription_expired'` set when subscription suspends
- [ ] Monitors: automatically unpause when subscription resumes (active)
- [ ] 7-day reminder sent exactly once per cycle
- [ ] 3-day reminder sent exactly once per cycle
- [ ] All reminders include VietQR + exact amount needed
- [ ] Billing engine completes < 30s for 1000 subscriptions
- [ ] Job failure: Telegram alert to admin, job marked failed, next schedule tries again

### Money-path coverage: 100%

### Verification Commands

```bash
# Manually trigger billing engine
node -e "require('./src/jobs/billing-engine').run()"

# Seed test: create 10 subscriptions with period_end=today
# Run billing engine twice; second run must do nothing (idempotency)
```

---

# Phase 7 — Monitoring Core

**Goal:** Actually check user's targets. HTTP, Ping, TCP, SSL, DNS, Keyword. Alert via Telegram and Email. Per-monitor prefs.

### Prerequisites
- Phase 6 complete
- Telegram bot created, token in `.env`, bot username known
- At least one test user with an active subscription

### Deliverables

1. **Checker runner** (`src/checker-runner.js`)
   - Entry point for `vpsmmo-monitoring-checker` PM2 process
   - node-cron `* * * * *` dispatcher

2. **Check types** (`src/modules/monitors/checks/`)
   - `http.js`: follow redirects? configurable per monitor. Verify status 2xx/3xx. Measure latency.
   - `ping.js`: ICMP via system `ping` or libs like `net-ping`. 4 packets, measure loss + avg RTT.
   - `tcp.js`: open TCP socket to host:port, connect-only, close. Timeout respected.
   - `ssl.js`: TLS handshake to host:port (default 443), read cert, compute `notAfter - now`. Alert N days before.
   - `dns.js`: resolve target domain, compare to `expected_value` (store in monitor config).
   - `keyword.js`: HTTP GET + search response body for keyword. Case sensitive option.

3. **Dispatcher** (`src/modules/monitors/dispatcher.js`)
   - Query due monitors
   - `p-limit(50)` for parallelism
   - Each check has hard timeout `monitor.timeout_sec`
   - Writes `monitor_checks` row, updates `monitors.status`
   - Detects status change, triggers alert

4. **Monitor CRUD** (`src/modules/monitors/`)
   - `routes.js`: full CRUD per ARCHITECTURE.md §5.2 Monitors section
   - Plan quota enforcement: creating monitor checks user's active subscription monitor_slots
   - Validation: target must be valid hostname/IP/URL (zod)
   - Check interval lower-bound based on plan's `min_check_interval_sec`

5. **Notification preferences** (`src/modules/monitors/prefs.js`)
   - `GET/PUT /api/monitors/:id/notifications`
   - Defaults on monitor create: telegram_enabled=true, email_enabled=false, alert_down_enabled=true, alert_up_enabled=true

6. **Alert dispatcher** (`src/modules/alerts/`)
   - `dispatcher.js`: follows ARCHITECTURE.md §3.7 dedup logic
   - `telegram-alert.js`: formatted message with monitor name, status, target, time, duration-down
   - `email-alert.js`: HTML + text, similar info
   - `webhook-alert.js`: POST JSON to user's webhook_url with HMAC signature

7. **Telegram verification flow** (`src/modules/telegram/`)
   - User clicks "Link Telegram" in dashboard
   - Generates 6-digit code, stored in `telegram_verification_codes`
   - User sends `/start CODE` to bot
   - Bot webhook (or polling in dev) receives, matches code, sets `users.telegram_chat_id`, `telegram_verified=true`
   - Separate bot handler module (`src/modules/telegram/bot.js`)

### Acceptance Criteria (Phase 7)

- [ ] Create HTTP monitor → dispatcher picks it up within 60s
- [ ] Check writes `monitor_checks` row with correct status
- [ ] HTTP check honors timeout (request to 10s delay, timeout=5, reports down)
- [ ] Ping check: unreachable IP reports down with correct error
- [ ] TCP check: closed port reports down
- [ ] SSL check: expired cert reports down; near-expiry triggers pre-expiry alert at configured days
- [ ] DNS check: resolves correct value passes; mismatch fails
- [ ] Keyword check: absent keyword reports down even on HTTP 200
- [ ] Status change up→down triggers alert (if enabled)
- [ ] Status change down→up triggers recovery alert (if enabled)
- [ ] Alert dedup: 5 down checks in 1 minute = 1 alert (not 5)
- [ ] Alert recovery sent immediately on up transition (no dedup for recovery)
- [ ] mute_until honored: no alerts during maintenance window
- [ ] Telegram alerts reach only verified chat_id
- [ ] Plan quota enforced: Starter user cannot create 2nd monitor
- [ ] Check interval lower-bound enforced: Starter plan cannot set interval < 300s
- [ ] Subscription suspend: all monitors under it are paused (pause_reason set)
- [ ] Subscription resume: monitors unpause
- [ ] Ownership: user cannot see/edit/delete another user's monitor
- [ ] 1000 simulated monitors run without crashing checker
- [ ] Check history cleanup removes rows older than 30 days

### Verification Commands

```bash
# Create monitor
curl -X POST http://localhost:3000/api/monitors \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test HTTP","type":"http","target":"https://google.com","check_interval_sec":60}'

# Wait 90s; check history
mysql vpsmmo_monitoring -e "SELECT * FROM monitor_checks WHERE monitor_id=<id> ORDER BY checked_at DESC LIMIT 5"

# Trigger down
mysql vpsmmo_monitoring -e "UPDATE monitors SET target='https://definitely-not-a-real-domain-12345.com' WHERE id=<id>"
# Wait 90s; should see telegram alert

# Dedup test: keep it down for 15 minutes; should see only 3 alerts (every 5 min)
```

---

# Phase 8 — Frontend + Admin Panel

**Goal:** User dashboard (EJS server-rendered). Admin panel. Actual human-usable UI.

### Prerequisites
- Phase 7 complete, all APIs working

### Deliverables

1. **Frontend views** (`views/`)
   - `layout.ejs` (base)
   - `auth/login.ejs`, `register.ejs`, `forgot.ejs`, `reset.ejs`
   - `dashboard.ejs` — overview: balance, active subscription, monitors count, recent alerts
   - `wallet.ejs` — top-up info (bank + QR + memo), transaction history
   - `plans.ejs` — plan comparison + purchase buttons
   - `monitors.ejs` — list
   - `monitor-detail.ejs` — history chart, notification prefs
   - `monitor-new.ejs`, `monitor-edit.ejs`
   - `subscriptions.ejs` — list + manage
   - `invoices.ejs` — list + download PDF
   - `settings.ejs` — email, password, Telegram link, 2FA (if in scope)
   - `admin/*.ejs` for admin panel

2. **Frontend assets** (`public/`)
   - Minimal CSS (Tailwind CDN or tiny custom)
   - Minimal JS (vanilla, no framework)
   - Mobile responsive

3. **Admin panel views** (`views/admin/`)
   - Dashboard (MRR, new users, churn)
   - Users list + search + detail
   - User detail: balance adjust form, subscriptions, invoices, login-as button
   - Plans management
   - Discount codes management
   - Pay2S webhook log viewer
   - Unmatched payments resolver
   - Broadcast form

4. **Login-as-client UX**
   - Admin clicks button → temp JWT issued (1h TTL) → redirect to dashboard
   - Red persistent banner on all pages: "⚠️ ADMIN VIEWING AS <email> — <time left>"
   - "Exit" button returns admin to own session

5. **Chart** for monitor uptime (Chart.js or uPlot via CDN)
   - 24h, 7d, 30d ranges
   - Response time line + up/down bars

### Acceptance Criteria (Phase 8)

- [ ] All pages render without JS errors
- [ ] Mobile responsive (test 375px width)
- [ ] Login flow works end-to-end from browser
- [ ] Top-up page shows correct bank info + memo + QR
- [ ] Purchase flow works from plans page
- [ ] Monitor detail page shows live chart of last 24h checks
- [ ] Admin dashboard shows correct MRR calculation
- [ ] Admin can login-as, banner shows, TTL enforced, exit works
- [ ] CSRF protection on all state-changing forms (use double-submit cookie pattern)
- [ ] No XSS: all user input escaped in EJS (default `<%= %>`, not `<%- %>`)
- [ ] Invoice PDF downloads with correct content-type

---

# Phase 9 — Adversarial Audit

**Goal:** Self-attack the system before real attackers do.

### Prerequisites
- All functional phases (1-8) complete

### Deliverables

Follow `ADVERSARIAL-TESTING.md` protocol. Each attack category must be executed and findings documented.

At the end: a `SECURITY-AUDIT-REPORT.md` with:
- Tests run
- Vulnerabilities found (severity: critical/high/medium/low)
- Fixes applied
- Remaining accepted risks with justification

### Acceptance Criteria (Phase 9)

- [ ] All adversarial tests from ADVERSARIAL-TESTING.md executed
- [ ] Zero critical vulnerabilities remain
- [ ] Zero high vulnerabilities in money paths
- [ ] All SECURITY-CHECKLIST.md items verified
- [ ] Penetration test report written
- [ ] Human reviewed report

---

# Phase 10 — Production Hardening

**Goal:** Deploy-ready. Nginx configured. SSL. Systemd for PM2. Backups. Self-monitoring.

### Prerequisites
- Phase 9 audit passed

### Deliverables

1. **Nginx config** deployed (`/etc/nginx/conf.d/monitoring.vpsmmo.vn.conf`)
2. **Let's Encrypt cert** issued + auto-renewal cron
3. **PM2 systemd service** (`pm2 startup systemd`)
4. **Database backup** (`scripts/backup-db.sh`)
   - Daily mysqldump → /var/backups/vpsmmo-monitoring/
   - 30-day retention
   - Restore tested
5. **Log rotation** configured (logrotate)
6. **Self-monitoring**: `monitor.vpsmmo.vn` (legacy Monitor v5) adds an HTTP check on `monitoring.vpsmmo.vn/health`
7. **Runbook** (`RUNBOOK.md`) for operations:
   - How to restart services
   - How to read logs
   - How to apply migration
   - How to rotate JWT secret
   - What to do when cron job fails
   - What to do when Pay2S webhook fails
   - Disaster recovery steps

### Acceptance Criteria (Phase 10)

- [ ] HTTPS works, A+ on SSL Labs
- [ ] PM2 processes auto-start on VPS reboot
- [ ] `./scripts/backup-db.sh` produces valid backup
- [ ] Restore from backup tested on staging
- [ ] Logs rotate daily, 30-day retention
- [ ] External monitor is watching /health
- [ ] Runbook covers all common ops scenarios

---

# 🚨 Cross-cutting rules for all phases

1. **Every phase starts with a plan statement.** Before touching code, post: "Here's what I'll build in Phase N. Approve?"
2. **Every phase ends with the completion report template.** No exceptions.
3. **Tests written BY a different pass than implementation.** Implement → step back → "now write tests" → run → fix. Do not implement and test in the same keystroke session.
4. **No phase shortcuts.** If you feel tempted to skip a checkbox, STOP and explain to human why.
5. **If acceptance criteria cannot be met**, do NOT edit the criteria to match reality. Escalate to human.
6. **Migrations in production are human-executed only.** Claude writes them; human applies.
7. **Every phase's work must respect ALL prior phases' rules.** Don't break Phase 3 while doing Phase 7.
8. **Documentation is part of deliverables.** Code + test + update relevant docs.

---

# Map from original scope (8 groups) to phases

For traceability back to human's approved scope:

| Scope group | Primary phase(s) |
|---|---|
| 1. Auth & User Mgmt | Phase 2 |
| 2. Wallet & Top-up | Phase 3, 4 |
| 3. Service Plans & Purchase | Phase 5 |
| 4. Subscription & Renewal | Phase 5, 6 |
| 5. Monitoring Core | Phase 7 |
| 6. Alerts & Notifications | Phase 7 |
| 7. Agent Scripts | DEFERRED (post-MVP, Phase 11+) |
| 8. Admin Panel | Phase 8 (main), cross-cutting in all phases |

---

# When in doubt

**STOP. ASK HUMAN. DOCUMENT.**

— End of MILESTONES.md —

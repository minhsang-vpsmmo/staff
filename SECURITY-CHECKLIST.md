# SECURITY-CHECKLIST.md — Pre-Done Verification for Every Phase

> **YOU (Claude Code) MUST tick every applicable item in this checklist before claiming any phase is done.**
> This is not optional. Skipping a checklist item because "tests pass" is forbidden.
> Many items below are NOT covered by unit tests — they require manual inspection.

---

## 🎯 How to use this file

1. **Before coding a phase:** Read the items tagged for that phase.
2. **While coding:** Keep the items in mind. Design code so items can be verified.
3. **Before claiming done:** Go through EVERY applicable item for this phase. For each:
   - ✅ Mark passed with brief evidence ("Verified in src/X.js line Y" or "Tested via curl: ...")
   - ❌ Mark failed → FIX the issue, don't skip
   - ⚠️ Mark not-applicable with reason
4. **In your Phase Completion Report:** List all SEC-XX items addressed.

**Rule:** A phase is not done until its applicable SEC items all show ✅ or ⚠️ with justification. ❌ items block phase completion.

---

## 🔢 Item numbering

- **SEC-A##** = Auth & session (Phases 2)
- **SEC-M##** = Money path (Phases 3, 4, 5, 6)
- **SEC-I##** = Input validation & injection (all phases)
- **SEC-S##** = Secrets & config (all phases)
- **SEC-D##** = Data access & authorization (all phases)
- **SEC-N##** = Network & transport (Phases 1, 10)
- **SEC-L##** = Logging & audit (all phases)
- **SEC-R##** = Rate limiting (Phases 2, 4, 7)
- **SEC-W##** = Webhook specific (Phase 4)
- **SEC-O##** = Ops & deployment (Phase 10)

---

# 🔐 SEC-A: Authentication & Session Security
(applies to Phase 2; re-verify after any auth change)

### SEC-A01 — Password storage
- [ ] Passwords stored ONLY as bcrypt hash with cost ≥ 12
- [ ] Hash format verified: `$2b$12$...` (test: query DB, inspect `password_hash`)
- [ ] Plain password NEVER written to logs
- [ ] Plain password NEVER returned in any API response

### SEC-A02 — Password policy
- [ ] Minimum length 8 characters enforced server-side (never trust client)
- [ ] Rejects common passwords (at least top-100 list: `password`, `12345678`, `qwerty123`, etc.)
- [ ] Allows Unicode/Vietnamese (`ậốả...`)
- [ ] No maximum length limit below 72 bytes (bcrypt ceiling)
- [ ] Password complexity hints shown to user, but not rejected if "medium strength"

### SEC-A03 — Login brute-force protection
- [ ] 5 failed attempts → account locked 15 minutes
- [ ] Lockout tracked per account (not per IP) — correct semantics
- [ ] Additional IP-level rate limit at Express middleware (2 req/s)
- [ ] Successful login clears failed counter
- [ ] Locked account returns 429 with clear retry time (not "account locked" which enumerates)

### SEC-A04 — Email enumeration prevention
- [ ] `/forgot-password` ALWAYS returns 200, regardless of whether email exists
- [ ] `/register` with existing email returns same shape as different error (does NOT say "email taken" unless acceptable trade-off documented by human)
- [ ] Login responses same timing whether user exists or not (bcrypt runs even on missing user via dummy hash)

### SEC-A05 — JWT security
- [ ] JWT signing key stored in env, not code
- [ ] Access token TTL ≤ 15 minutes
- [ ] Refresh token TTL ≤ 30 days
- [ ] JWT secret differs between access and refresh tokens
- [ ] JWT does NOT contain password, balance, or other sensitive data in payload
- [ ] JWT payload includes: `sub` (userId), `role`, `iat`, `exp`, nothing else
- [ ] Algorithm pinned to HS256 (reject tokens with `alg: none` or `RS256` forgery)
- [ ] Invalid/expired JWT returns 401, not 403 or 500

### SEC-A06 — Refresh token handling
- [ ] Refresh tokens stored as bcrypt hash in `user_sessions`, never plaintext
- [ ] Refresh token rotation on every use (old one revoked immediately)
- [ ] Refresh cookies: `httpOnly` + `secure` + `sameSite=strict` + `path=/api/auth`
- [ ] Logout endpoint revokes current session (row update, not delete)
- [ ] `logout-all` revokes every active session for user
- [ ] Revoked sessions reject subsequent refresh attempts

### SEC-A07 — Email verification
- [ ] Verify token = `nanoid(32)` or equivalent CSPRNG, minimum 128 bits entropy
- [ ] Token single-use (set to NULL after verification)
- [ ] Token expires ≤ 48 hours
- [ ] Expired token returns friendly error, not 500

### SEC-A08 — Password reset
- [ ] Reset token stored as sha256 hash, never plaintext
- [ ] Reset token single-use
- [ ] Reset token expires ≤ 1 hour
- [ ] Using reset token invalidates all existing sessions (force re-login)
- [ ] Reset success does NOT auto-login (require separate login)

### SEC-A09 — Change password flow
- [ ] Requires current password to confirm
- [ ] Changing password revokes all OTHER sessions, keeps current
- [ ] Same bcrypt cost applied

### SEC-A10 — Admin role checks
- [ ] Admin endpoints gated by middleware that checks `role IN ('admin','superadmin')`
- [ ] Role cannot be self-modified by user (POST /api/me cannot change role)
- [ ] Admin role changes logged to `admin_audit_log`

---

# 💰 SEC-M: Money Path Security
(applies to Phases 3, 4, 5, 6 — the most critical section)

### SEC-M01 — Decimal arithmetic
- [ ] All VND amounts use `decimal.js` Decimal instances or `DECIMAL(15,2)` column
- [ ] No `Number` / `float` / `parseFloat` on money values (grep verified)
- [ ] No arithmetic like `balance + amount` in application code — only `decimal.add(a,b)`
- [ ] Format/display uses dedicated format function (no ad-hoc `toFixed`)
- [ ] Test: `0.1 + 0.2 === 0.3` scenario verified with real fixture

### SEC-M02 — Atomic transactions
- [ ] Every credit/debit wrapped in `BEGIN ... COMMIT`
- [ ] Every money mutation uses `SELECT ... FOR UPDATE` on the user row
- [ ] Transaction row written BEFORE `users.balance` UPDATE, same transaction
- [ ] Rollback on any error inside money transaction (verified via try/catch)
- [ ] Connection released after transaction in `finally` block

### SEC-M03 — Idempotency
- [ ] Every external trigger (webhook, cron, admin action) has idempotency key
- [ ] Idempotency key stored in `wallet_transactions.idempotency_key` with UNIQUE constraint
- [ ] Duplicate key returns `{duplicate: true}` without error, without side effects
- [ ] Idempotency check is BEFORE any state mutation (not after)

### SEC-M04 — Insufficient balance handling
- [ ] Debit with insufficient balance throws `InsufficientBalanceError`, returns 402
- [ ] Balance NEVER goes negative (hard invariant)
- [ ] No "partial debit" — either full success or full failure

### SEC-M05 — Invariant checks
- [ ] After any money phase: `SUM(wallet_transactions.amount) per user = users.balance`
- [ ] Verified via DB query after every integration test suite
- [ ] CI or manual check script exists (scripts/check-invariants.sh)

### SEC-M06 — Audit trail
- [ ] Every money movement has a `wallet_transactions` row
- [ ] Admin adjustments also have `admin_audit_log` row with reason
- [ ] Audit rows are INSERT-only (never UPDATE or DELETE in code)
- [ ] `admin_reason` field required and min-length validated (≥ 10 chars)

### SEC-M07 — Server-side price computation
- [ ] Purchase amount calculated SERVER-SIDE from plan lookup, never from client body
- [ ] Discount amount calculated server-side from `discount_codes` table
- [ ] Client cannot supply custom amount, custom price, custom discount

### SEC-M08 — Refund handling
- [ ] Refunds are written as `type='refund'` transactions with positive amount
- [ ] NEVER "adjust balance and pretend nothing happened"
- [ ] Refund references original transaction via `ref_id`

### SEC-M09 — Race condition tests
- [ ] Concurrent credit test (10 parallel) → final balance matches sum
- [ ] Concurrent debit test (race to insufficient) → only first succeeds
- [ ] Concurrent duplicate webhook test → exactly one credit

### SEC-M10 — Discount code abuse prevention
- [ ] `used_count` incremented atomically (row lock or increment-and-check pattern)
- [ ] Per-user usage enforced via `discount_code_usages` unique pair (user_id, code_id) or row count
- [ ] Expired codes rejected at server
- [ ] Codes not applicable to plan rejected at server

---

# 🧱 SEC-I: Input Validation & Injection Prevention
(applies to all phases)

### SEC-I01 — SQL injection
- [ ] All SQL uses parameterized queries via `?` placeholders in `mysql2/promise`
- [ ] No string concatenation of user input into SQL (grep verified)
- [ ] No dynamic table/column names from user input
- [ ] Pagination `LIMIT`/`OFFSET` params cast to integer server-side

### SEC-I02 — Request body validation
- [ ] Every POST/PATCH/PUT endpoint validates body with zod schema
- [ ] Validation errors return 400 with safe error details (field, constraint)
- [ ] Unknown fields rejected (`.strict()` or explicit whitelist)
- [ ] Max body size enforced at Express middleware (100kb general, 10kb auth)

### SEC-I03 — Query parameter validation
- [ ] Query params validated via zod (types coerced, bounded)
- [ ] Pagination params capped (page ≤ 10000, per_page ≤ 100)
- [ ] Date params parsed safely (`new Date(str)` with NaN check)

### SEC-I04 — Path parameter validation
- [ ] Numeric IDs validated as positive integers
- [ ] Slug/code params length-limited (e.g., discount code ≤ 50 chars)
- [ ] Invalid format returns 400, not 500

### SEC-I05 — Email format
- [ ] Email validated via zod email schema
- [ ] Length cap ≤ 190 (matches DB column)
- [ ] Stored normalized (lowercase, trimmed)

### SEC-I06 — URL validation (monitor targets, webhooks)
- [ ] Target URLs: scheme must be http/https only
- [ ] Webhook URLs: must be https in production (no http)
- [ ] Reject internal IPs for outbound checks/webhooks (SSRF prevention):
  - `127.0.0.0/8`
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`
  - `169.254.0.0/16`
  - `::1/128`, `fc00::/7`, `fe80::/10`
- [ ] Exception: allow these in dev mode via env flag only

### SEC-I07 — File upload (if any)
- [ ] MIME type validated server-side (don't trust client Content-Type)
- [ ] File size capped
- [ ] Path traversal prevented (no `..`, no absolute paths)

### SEC-I08 — XSS prevention
- [ ] EJS templates use `<%= %>` (auto-escape), not `<%- %>` (unsafe raw)
- [ ] User content in emails escaped (or use templating with auto-escape)
- [ ] JSON responses set `Content-Type: application/json; charset=utf-8`
- [ ] Reflect-and-escape: any user input echoed back must be escaped

### SEC-I09 — Telegram input
- [ ] Chat ID validated as numeric string before storing
- [ ] User-controlled text going to Telegram uses HTML parse mode with escape
- [ ] Telegram verification code validated as 6-digit numeric

### SEC-I10 — Monitor keyword/target input
- [ ] Keyword length capped (≤ 200 chars)
- [ ] Target hostname validated as RFC 1123 format
- [ ] Port validated as 1-65535 integer

---

# 🔑 SEC-S: Secrets & Configuration
(applies to all phases, especially Phase 1)

### SEC-S01 — .env hygiene
- [ ] `.env` listed in `.gitignore` BEFORE first commit
- [ ] `.env.example` committed with placeholder values only
- [ ] `.env` file permission is 600 (owner read/write only)
- [ ] `.env` NOT readable by nginx/www-data

### SEC-S02 — Secret strength
- [ ] JWT_ACCESS_SECRET is ≥ 32 bytes random (verify via env validation)
- [ ] JWT_REFRESH_SECRET differs from ACCESS, also ≥ 32 bytes
- [ ] PAY2S_WEBHOOK_SECRET matches Pay2S platform value exactly
- [ ] DB_PASSWORD is strong (≥ 16 chars, mixed)
- [ ] SMTP_APP_PASSWORD is Gmail App Password (not main password)

### SEC-S03 — Secret rotation capability
- [ ] JWT secret rotation procedure documented in RUNBOOK
- [ ] DB password rotation procedure documented
- [ ] Pay2S webhook secret rotation procedure documented
- [ ] No hardcoded "old" and "new" secrets in code (clean cutover via env)

### SEC-S04 — No secrets in code
- [ ] grep `-rE "AIzaSy|sk_live_|Bearer [A-Za-z0-9_-]{20,}|BEGIN PRIVATE KEY"` in src/ returns nothing
- [ ] No `console.log(process.env.*_SECRET)` anywhere
- [ ] Pre-commit hook blocks suspicious patterns

### SEC-S05 — No secrets in logs
- [ ] Logger redaction config active (pino `redact: [...]`)
- [ ] `authorization` header never logged in full (redacted)
- [ ] Request body of `/api/auth/*` never logged in full
- [ ] Pay2S webhook payload logged in audit table, NOT application log with token

### SEC-S06 — Boot-time env validation
- [ ] Missing required env causes process exit 1 with clear message
- [ ] Weak secrets detected at boot (e.g., JWT_SECRET length < 32 exits with warning)
- [ ] Env file path/perms checked at boot

### SEC-S07 — Development vs production split
- [ ] `NODE_ENV=production` enforces stricter validation
- [ ] Dev-only bypasses (e.g., disable email verify) require explicit flag (`SKIP_EMAIL_VERIFY_IN_DEV=1`)
- [ ] No dev bypass code path in production builds

---

# 🧭 SEC-D: Data Access & Authorization
(applies to all phases)

### SEC-D01 — Ownership enforcement
- [ ] Every `/api/monitors/:id` query filters `WHERE user_id = req.user.id`
- [ ] Every `/api/subscriptions/:id` same
- [ ] Every `/api/invoices/:id` same
- [ ] Every `/api/wallet/transactions` same
- [ ] Admin endpoints separately gated; don't share handler with user endpoints

### SEC-D02 — IDOR (Insecure Direct Object Reference) prevention
- [ ] 404 (not 403) returned when accessing another user's resource (no enumeration)
- [ ] Or: 403 returned consistently regardless of existence
- [ ] Tests verify: user A cannot see user B's monitor via ID manipulation

### SEC-D03 — Admin login-as audit
- [ ] `POST /api/admin/users/:id/login-as` writes `admin_audit_log` with target user, admin id, IP, timestamp
- [ ] Temp JWT issued contains `acted_as=true` and `admin_id=original`
- [ ] All actions during login-as session tagged as admin-initiated in audit log
- [ ] Red banner enforced on every page
- [ ] TTL strictly 1 hour (no extension)

### SEC-D04 — User data deletion (soft)
- [ ] "Ban" sets `status='banned'`, does not hard delete
- [ ] Banned user cannot login, but audit trail preserved
- [ ] User data deletion (GDPR-ish) procedure documented but MANUAL process

### SEC-D05 — Sensitive data response filtering
- [ ] `GET /api/me` never returns `password_hash`
- [ ] `GET /api/admin/users/:id` never returns `password_hash`
- [ ] No endpoint returns raw `email_verify_token`, reset tokens, agent tokens

### SEC-D06 — Pagination limits
- [ ] All list endpoints paginated
- [ ] Max per_page enforced (≤ 100)
- [ ] No "give me all" endpoint (`?per_page=999999` rejected)

---

# 🌐 SEC-N: Network & Transport
(applies to Phase 1 setup, Phase 10 hardening)

### SEC-N01 — HTTPS only
- [ ] Nginx redirects 80 → 443
- [ ] HSTS header set (max-age ≥ 31536000)
- [ ] Secure cookies require secure flag (doesn't send over HTTP)

### SEC-N02 — TLS config
- [ ] TLS 1.2 minimum, 1.3 preferred
- [ ] Disable weak ciphers (no RC4, no 3DES, no EXPORT ciphers)
- [ ] SSL Labs grade target: A+

### SEC-N03 — Security headers
- [ ] `X-Frame-Options: DENY`
- [ ] `X-Content-Type-Options: nosniff`
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] `Content-Security-Policy` set (start strict, loosen per-page if needed)
- [ ] `Permissions-Policy` denying unused (camera, mic, geo, etc.)

### SEC-N04 — CORS
- [ ] Same-origin only (no `Access-Control-Allow-Origin: *`)
- [ ] Credentials false unless needed
- [ ] Methods whitelist (GET, POST, PATCH, DELETE) not `*`

### SEC-N05 — Outbound requests (monitor checks)
- [ ] Hard timeout on all outbound checks (respect `monitor.timeout_sec`)
- [ ] Max response size cap for keyword check (e.g., 5 MB)
- [ ] SSRF protections per SEC-I06
- [ ] User agent identifies us: `VPSMMO-Monitoring/1.0`

### SEC-N06 — Pay2S webhook network
- [ ] Webhook endpoint accepts POST only (405 on GET)
- [ ] Body size cap (64 KB — Pay2S payloads are small)
- [ ] Nginx IP whitelist configured (once Pay2S IPs known)
- [ ] Nginx logs webhook requests separately for audit

---

# 📝 SEC-L: Logging & Audit
(applies to all phases)

### SEC-L01 — Structured logs
- [ ] All logs via pino (no raw `console.log` in production code)
- [ ] Log lines include: timestamp, level, module, event, relevant IDs
- [ ] Log files at `/var/log/vpsmmo-monitoring/` with 600 perm

### SEC-L02 — No sensitive data in logs
- [ ] Passwords never logged (redacted by pino config)
- [ ] Full JWTs never logged (log `token.slice(0,10) + '...'` if needed for debug)
- [ ] Pay2S Bearer header never logged
- [ ] Credit card info: N/A (not collected) — verify no accidental logging of any card-like pattern

### SEC-L03 — Admin audit completeness
- [ ] Every admin action writes `admin_audit_log` row
- [ ] Log row includes: admin_id, action, target_type, target_id, reason, IP, timestamp
- [ ] Audit log is INSERT-only in application code (no UPDATE/DELETE)
- [ ] Audit retention: indefinite (manual archival procedure only)

### SEC-L04 — Security event logs (separate stream)
- [ ] Failed logins logged at INFO with user email (for lockout detection)
- [ ] Invalid JWT attempts logged
- [ ] Rate limit hits logged
- [ ] Webhook signature failures logged at WARN
- [ ] SSRF attempts (blocked outbound) logged at WARN

### SEC-L05 — Log rotation
- [ ] logrotate configured daily, 30 days retention
- [ ] Compressed after rotation (saves disk)
- [ ] Log files don't fill disk (monitor disk space via cron)

---

# 🚦 SEC-R: Rate Limiting
(applies to Phases 2, 4, 7)

### SEC-R01 — Auth endpoints
- [ ] `/api/auth/login`: 5 per 5 min per IP
- [ ] `/api/auth/register`: 3 per hour per IP
- [ ] `/api/auth/forgot-password`: 3 per hour per IP + 3 per hour per email
- [ ] `/api/auth/reset-password`: 5 per hour per IP

### SEC-R02 — General API
- [ ] Default 100 req/min per user (authenticated)
- [ ] 50 req/min per IP (unauthenticated)
- [ ] Exempt: health check, static assets

### SEC-R03 — Pay2S webhook
- [ ] NOT rate limited by application (Pay2S already limits)
- [ ] Nginx IP whitelist is the security layer, not rate limit

### SEC-R04 — Agent/monitor endpoints (future)
- [ ] Agent push: 60 per min per token
- [ ] Monitor webhook user-provided URL: respect our target's limits (exponential backoff on 429)

### SEC-R05 — Admin endpoints
- [ ] Rate limited to 200 per minute (higher tier for ops work)
- [ ] Bulk operations (broadcast) have separate limit (5 per hour)

### SEC-R06 — Rate limit response format
- [ ] Returns HTTP 429 with `Retry-After` header
- [ ] Body includes `retry_at` timestamp
- [ ] No email enumeration via rate limit differences

---

# 🪝 SEC-W: Pay2S Webhook Security
(applies specifically to Phase 4)

### SEC-W01 — Bearer token verification
- [ ] `Authorization: Bearer X` header required, 401 otherwise
- [ ] Constant-time compare (`crypto.timingSafeEqual`)
- [ ] Token loaded from env (`PAY2S_WEBHOOK_SECRET`), never hardcoded

### SEC-W02 — IP whitelist (Nginx layer)
- [ ] Once Pay2S IPs known: `allow` directives in Nginx config
- [ ] Before IPs known: document as P1 TODO, but not blocking
- [ ] Verify header `X-Forwarded-For` handling (use Nginx `$remote_addr`)

### SEC-W03 — Payload validation
- [ ] Body shape checked: `{transactions: [...]}`
- [ ] Each transaction validated: required fields present, types correct
- [ ] Malformed payload returns 400 but still logs to `pay2s_webhooks` for audit

### SEC-W04 — Idempotency via checksum
- [ ] `pay2s_webhooks.checksum` has UNIQUE constraint
- [ ] Duplicate checksum caught via `ER_DUP_ENTRY`
- [ ] Processing is skipped but HTTP 200 returned (prevents retry loop)

### SEC-W05 — Transfer type filter
- [ ] Only `transferType === 'IN'` triggers credit
- [ ] `OUT` transactions logged but ignored
- [ ] Unknown types logged with alert to admin

### SEC-W06 — Minimum amount
- [ ] Transactions below `MIN_TOPUP_VND` (10,000) marked processed with reason, NOT credited
- [ ] Protects against penny-attack exploration

### SEC-W07 — Memo parsing strictness
- [ ] Regex anchored to known patterns
- [ ] Multiple matches in same content: take first
- [ ] No fallback to "if regex fails, try fuzzy match" — unmatched = admin review

### SEC-W08 — Unmatched payment flow
- [ ] Unmatched always logged to `unmatched_payments`
- [ ] Admin alerted via Telegram with critical priority
- [ ] Admin resolve endpoint requires explicit `user_id` + `reason`
- [ ] Resolve action writes audit log + wallet transaction

### SEC-W09 — Bank account verification
- [ ] `accountNumber` in payload matches one in `PAY2S_BANK_ACCOUNTS` env
- [ ] Mismatched account number: log WARN, treat as unmatched (don't credit)

### SEC-W10 — Response always HTTP 200 with success shape
- [ ] After processing (success or internal failure), respond `{success: true}` HTTP 200
- [ ] Prevents Pay2S retry loops that could cause double-processing
- [ ] Internal failures trigger admin Telegram alert instead

---

# 🛠️ SEC-O: Operational Security
(applies specifically to Phase 10)

### SEC-O01 — Process isolation
- [ ] Node processes run as non-root user (e.g., `vpsmmo` user)
- [ ] Working directory not world-readable
- [ ] Log directory not world-readable

### SEC-O02 — Database user least-privilege
- [ ] `vpsmmo_monitoring` DB user has: SELECT, INSERT, UPDATE, DELETE on application tables
- [ ] DB user does NOT have: DROP, ALTER, CREATE, GRANT
- [ ] Separate admin DB user for migrations (only used during migration)

### SEC-O03 — Backup procedure
- [ ] Daily mysqldump at 02:00
- [ ] Backups stored at `/var/backups/vpsmmo-monitoring/` with 600 perm
- [ ] 30-day retention
- [ ] Monthly test-restore to staging (documented procedure)
- [ ] Offsite copy procedure documented (even if manual)

### SEC-O04 — Monitoring of self
- [ ] Legacy Monitor v5 watches `monitoring.vpsmmo.vn/health`
- [ ] Disk space alert at 80%
- [ ] DB connection failure alerts via Telegram
- [ ] PM2 process crash alerts

### SEC-O05 — Firewall
- [ ] iptables/firewalld: only 22, 80, 443 exposed publicly
- [ ] SSH on non-default port OR key-only (no password auth)
- [ ] fail2ban configured for SSH + Nginx

### SEC-O06 — SSH hygiene
- [ ] Root login disabled (`PermitRootLogin no`)
- [ ] Password auth disabled (`PasswordAuthentication no`)
- [ ] Keys rotated when ops team changes

### SEC-O07 — PM2 ops
- [ ] `pm2 startup systemd` enabled — survives reboot
- [ ] `pm2 save` after changes
- [ ] PM2 monit accessible on internal network only (not exposed)

### SEC-O08 — Nginx hygiene
- [ ] Server tokens hidden (`server_tokens off`)
- [ ] No default server config serving this domain
- [ ] Let's Encrypt renewal cron tested manually

### SEC-O09 — Dependency updates
- [ ] `npm audit` shows no high/critical vulnerabilities
- [ ] `package-lock.json` committed and used in production
- [ ] Monthly manual `npm outdated` review

### SEC-O10 — Disaster recovery
- [ ] RUNBOOK.md documents DR steps
- [ ] Team knows how to restore from backup
- [ ] Secondary admin has access to DNS, DB backups, env vault

---

# 📋 Per-Phase Summary (quick lookup)

## Phase 1 (Foundation)
Must pass: SEC-S01, S02, S04, S05, S06, S07, I01 (baseline), L01, L05, N03, O02 (baseline), O07 (PM2 boot)

## Phase 2 (Auth)
Must pass: All SEC-A01-A10, SEC-R01, SEC-I02, I05, I08, L02, L04

## Phase 3 (Wallet Core)
Must pass: All SEC-M01-M09, SEC-D01, D05

## Phase 4 (Pay2S)
Must pass: All SEC-W01-W10, SEC-M01-M09 (re-verify), SEC-L04 (webhook logs)

## Phase 5 (Plans/Subscriptions)
Must pass: SEC-M01-M10 (especially M07, M10), SEC-D01-D06

## Phase 6 (Billing Engine)
Must pass: SEC-M01-M09 (re-verify), SEC-L04 (cron logs), idempotency tests

## Phase 7 (Monitoring Core)
Must pass: SEC-I06 (SSRF critical here), SEC-N05, SEC-R04, SEC-I09, I10

## Phase 8 (Frontend/Admin)
Must pass: SEC-I08 (XSS), SEC-D01-D05, SEC-A10, SEC-D03 (login-as audit)

## Phase 9 (Adversarial Audit)
Must pass: EVERY SEC-* item re-verified end-to-end

## Phase 10 (Production)
Must pass: SEC-N01-N06, SEC-O01-O10

---

# 🧰 Verification Scripts

YOU (Claude Code) should create these helper scripts during Phase 1 and expand as phases progress:

### `scripts/check-invariants.sh`
```bash
#!/bin/bash
# Run after any money phase
mysql -N -e "
  USE vpsmmo_monitoring;
  SELECT COUNT(*) AS broken_users FROM (
    SELECT u.id, u.balance, 
           COALESCE(SUM(wt.amount), 0) AS txn_sum
    FROM users u 
    LEFT JOIN wallet_transactions wt ON u.id = wt.user_id
    GROUP BY u.id 
    HAVING u.balance != COALESCE(SUM(wt.amount), 0)
  ) t;
"
```

### `scripts/check-secrets.sh`
```bash
#!/bin/bash
# Grep for accidentally committed secrets
git ls-files src/ | xargs grep -nE \
  "AIzaSy|sk_live_|Bearer [A-Za-z0-9_-]{20,}|BEGIN PRIVATE KEY|password.*=.*[\"'][^\"']{8,}"
```

### `scripts/check-owner-leaks.sh`
```bash
#!/bin/bash
# Find SELECT queries without user_id filter in modules that should have it
grep -nE "SELECT .* FROM (monitors|invoices|user_subscriptions|wallet_transactions)" src/modules/ \
  | grep -v "user_id\|admin"
# Should return empty (or only admin endpoints)
```

### `scripts/npm-audit-strict.sh`
```bash
#!/bin/bash
npm audit --audit-level=high
# Non-zero exit if high/critical vulns
```

---

# ⚠️ Common mistakes Claude Code makes (avoid these)

Based on past experience with AI-generated fintech code:

1. **"Tests pass, ship it"** — Tests don't cover everything. Use THIS checklist.
2. **Reusing a service function for admin shortcut** — Admin ops must route through documented admin endpoints with audit logging.
3. **Trusting `req.body.amount`** — Always recompute server-side from plan/invoice.
4. **Catching errors silently to "make it work"** — Re-read CLAUDE.md §2.8 prohibited patterns.
5. **Adding a `// TODO: proper validation later`** — This is how security holes ship. Do it now or escalate.
6. **"Just this once" hardcoded secret for testing** — Move to `.env` immediately, don't commit placeholder.
7. **Copy-pasting the webhook handler** — Security-critical code must be reviewed line-by-line, not templated.
8. **Confusing 404 and 403** — Decide the semantic per endpoint and be consistent.
9. **Logging user input directly** — Always consider "could this contain a token?" before logging.
10. **Generating random IDs via `Math.random()`** — Use `crypto.randomBytes()` or `nanoid()`.

---

# 🔚 Final rule

If you cannot tick a SEC-* item and cannot fix it, DO NOT claim phase done. Escalate to human with:

```
❌ SEC-XX cannot be verified because <reason>.
Proposed resolutions:
  Option A: <...>
  Option B: <...>
Recommended: <one> with rationale.
```

Do not silently skip. Do not reword the criterion. Do not declare it "not applicable" to avoid work.

**This checklist is the line between "it works on my laptop" and "it survives production."**

— End of SECURITY-CHECKLIST.md —

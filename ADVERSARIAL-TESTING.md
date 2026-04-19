# ADVERSARIAL-TESTING.md — Self-Attack Protocol

> **YOU (Claude Code) must execute this protocol. This is the final defense layer.**
> The assumption behind this document: an attacker WILL try these exact attacks against production. Better to find holes now than after money is lost.
> You will act as the attacker. You will try to break your own code. You will document what you find.

---

## 🎯 The mindset shift

When writing code: you think "how do I make this work?"
When running this protocol: you think **"how do I make this break?"**

These are different mental modes. You must deliberately switch. Do not be defensive of your own code — an AI writing gentle tests on its own implementation is worthless. Be ruthless.

**If a test doesn't break anything, the test is probably weak. Keep escalating until you find a real failure or you're confident no failure exists.**

---

## 🧭 When to run this protocol

- **After each phase 3-7 is complete**: run the attacks relevant to that phase.
- **Phase 9 (Adversarial Audit)**: run ALL attacks, end-to-end, as a final gate before launch.
- **After any significant change**: re-run relevant categories.

Each attack has:
- **ID** (for referencing in report)
- **Target** (which code is being attacked)
- **Attack description**
- **How to perform** (exact command or test code)
- **Expected defense** (what should happen when defenses work)
- **Failure signal** (what "attack succeeded" looks like — if you see this, you have a vulnerability)

---

## 📋 Vulnerability severity (use this rating)

| Severity | Criteria | Must-fix before launch? |
|---|---|---|
| **CRITICAL** | Money loss, full auth bypass, full data breach | YES, zero tolerance |
| **HIGH** | Privilege escalation, targeted data leak, webhook replay | YES |
| **MEDIUM** | Info disclosure, DoS via expensive op, IDOR limited scope | YES if money-related, else prioritize |
| **LOW** | Verbose error messages, timing differences with no exploit path | Document, fix when possible |
| **INFO** | Best-practice deviation without clear exploit | Note in report |

---

# 🔥 Attack Categories

## ATK-A: Authentication Bypass & Session Attacks

### ATK-A01 — JWT `alg:none` forgery
- **Target**: JWT verification middleware
- **Attack**: Craft a JWT with header `{"alg":"none","typ":"JWT"}`, payload `{"sub":1,"role":"superadmin"}`, no signature. Base64url encode. Send as `Authorization: Bearer <forged>`.
- **How**: 
  ```bash
  HEADER=$(echo -n '{"alg":"none","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-')
  PAYLOAD=$(echo -n '{"sub":1,"role":"superadmin","iat":1700000000,"exp":9999999999}' | base64 | tr -d '=' | tr '/+' '_-')
  curl -H "Authorization: Bearer $HEADER.$PAYLOAD." http://localhost:3000/api/admin/users
  ```
- **Expected defense**: 401 with clear error. JWT lib rejects `alg:none`.
- **Failure signal**: 200 response with admin data. **CRITICAL.**

### ATK-A02 — JWT algorithm confusion (HS256 → RS256)
- **Target**: JWT verify function
- **Attack**: If code uses public key as HMAC secret, attacker can forge. Verify code locks algorithm.
- **How**: Inspect `jwt.verify()` call — must pass `{algorithms: ['HS256']}` option.
- **Expected defense**: Algorithm pinned to HS256 only.
- **Failure signal**: No algorithm specified, or allows multiple. **CRITICAL.**

### ATK-A03 — JWT replay after logout
- **Target**: Session invalidation on logout
- **Attack**: Login → get token → logout → try to use the token.
- **How**:
  ```bash
  TOKEN=$(curl -X POST /api/auth/login -d '...' | jq -r .access_token)
  curl -X POST /api/auth/logout -H "Authorization: Bearer $TOKEN"
  curl -H "Authorization: Bearer $TOKEN" /api/me  # should fail
  ```
- **Expected defense**: 401. Access token is short-lived (15min), refresh token revoked.
- **Accepted risk**: Short-lived access token still valid until expiry. Document this as known limitation. Full invalidation requires token blacklist (deferred to Phase 9 if needed).
- **Failure signal**: Token works days after logout. **HIGH.**

### ATK-A04 — Refresh token reuse
- **Target**: Refresh token rotation
- **Attack**: Use same refresh token twice. Second use must fail.
- **How**:
  ```bash
  # First refresh - should work
  curl -X POST /api/auth/refresh -b "refresh_token=$RT" 
  # Second refresh with SAME RT - should fail
  curl -X POST /api/auth/refresh -b "refresh_token=$RT"
  ```
- **Expected defense**: Second call returns 401. All user sessions should be revoked (reuse indicates compromise).
- **Failure signal**: Second call succeeds with new tokens. **HIGH.**

### ATK-A05 — Brute force login (bypass lockout)
- **Target**: Rate limiting + account lockout
- **Attack**: 
  1. Sequential: 5 wrong attempts → 6th must lock
  2. Parallel: 20 concurrent wrong attempts → must not leak through race
  3. After lockout: try changing source IP (X-Forwarded-For) — lockout should still apply (it's per account)
- **How**:
  ```bash
  for i in {1..10}; do
    curl -X POST /api/auth/login -d '{"email":"victim@test.com","password":"wrong'$i'"}' &
  done
  wait
  # Now try correct password - should still be locked
  curl -X POST /api/auth/login -d '{"email":"victim@test.com","password":"CORRECT_PW"}'
  ```
- **Expected defense**: Account locked after 5 attempts. Race doesn't let through 6th+.
- **Failure signal**: Login succeeds despite lockout, OR 20 parallel requests all count as 1. **HIGH.**

### ATK-A06 — User enumeration via timing
- **Target**: Login endpoint timing
- **Attack**: Measure response time for existing vs non-existing email. Difference reveals which emails are registered.
- **How**:
  ```bash
  # Run 100 times each, compare avg
  for i in {1..100}; do
    time curl -X POST /api/auth/login -d '{"email":"exists@test.com","password":"wrong"}'
  done
  for i in {1..100}; do
    time curl -X POST /api/auth/login -d '{"email":"nonexistent@test.com","password":"wrong"}'
  done
  ```
- **Expected defense**: Timings within 10% of each other (bcrypt runs on dummy hash for nonexistent users).
- **Failure signal**: Nonexistent returns 50ms, existing returns 200ms. **MEDIUM.**

### ATK-A07 — Admin role self-escalation
- **Target**: `/api/me` or profile update endpoints
- **Attack**: Normal user sends PATCH with `role: "admin"` or `is_admin: true`.
- **How**:
  ```bash
  curl -X PATCH /api/me -H "Authorization: Bearer $USER_TOKEN" \
    -d '{"email":"new@test.com","role":"superadmin","is_admin":true,"balance":9999999}'
  ```
- **Expected defense**: 400 with validation error (unknown fields) OR silently strip unknown fields. Role/balance NOT updated in DB.
- **Failure signal**: User now has admin access, or balance changed. **CRITICAL.**

### ATK-A08 — Password reset token reuse
- **Target**: Reset flow
- **Attack**: Use reset token twice.
- **How**: Request reset → receive email → extract token → reset password → try to reset again with same token.
- **Expected defense**: Second attempt fails (token marked used).
- **Failure signal**: Second reset succeeds. **HIGH.**

### ATK-A09 — Session fixation
- **Target**: Login flow
- **Attack**: Attacker sets a cookie in victim's browser, victim logs in, attacker uses the same cookie.
- **How**: This is defended by the fact that refresh token is SET by server on login, not trusted from client. Verify code does NOT read any session-like cookie before login.
- **Expected defense**: Fresh session token issued on every login.
- **Failure signal**: Pre-existing session ID kept active post-login. **HIGH.**

### ATK-A10 — Admin `login-as` abuse
- **Target**: Admin login-as endpoint
- **Attack**: Can a non-admin call `/api/admin/users/:id/login-as`?
- **How**: Call with normal user's JWT.
- **Expected defense**: 403.
- **Failure signal**: Endpoint returns temp JWT. **CRITICAL.**

---

## 💰 ATK-M: Money Manipulation

### ATK-M01 — Negative amount top-up
- **Target**: Pay2S webhook, admin balance adjust
- **Attack**: 
  1. Fake webhook with `transferAmount: -50000`
  2. Admin adjust with `amount: -50000` (this might be legit — it's a debit)
- **How**:
  ```bash
  curl -X POST /api/webhook/pay2s \
    -H "Authorization: Bearer $PAY2S_SECRET" \
    -d '{"transactions":[{"id":"FAKE","checksum":"abc","transferAmount":-50000,"transferType":"IN","content":"VPSMMO1","accountNumber":"X","gateway":"ACB","transactionDate":"2025-01-01 00:00:00","transactionNumber":"1"}]}'
  ```
- **Expected defense**: Webhook rejects negative transferAmount for IN transactions. Admin adjust allows negative only with `admin_adjust` type and audit log.
- **Failure signal**: Balance decreases. **CRITICAL.**

### ATK-M02 — Replay webhook with same checksum
- **Target**: Pay2S webhook idempotency
- **Attack**: Send exact same valid webhook 100 times in parallel.
- **How**:
  ```bash
  for i in {1..100}; do
    curl -X POST /api/webhook/pay2s \
      -H "Authorization: Bearer $PAY2S_SECRET" \
      -d "$(cat sample-webhook.json)" &
  done
  wait
  ```
  Then check DB: `SELECT balance FROM users WHERE id=<target>` — should have credited ONCE only.
- **Expected defense**: UNIQUE constraint on checksum catches duplicates. Only one credit.
- **Failure signal**: Balance credited multiple times. **CRITICAL.**

### ATK-M03 — Modified amount after checksum generation
- **Target**: Webhook data integrity
- **Attack**: Craft webhook with valid checksum but amount inflated (e.g., attacker learns format, generates their own "checksum" for 10M VND).
- **How**: Submit webhook with `transferAmount: 10000000` + any `checksum: "attacker-generated"`.
- **Expected defense**: Bearer token verification catches unauthorized webhook. Pay2S IP whitelist at Nginx adds second layer.
- **Failure signal**: Accepted without valid Bearer. **CRITICAL.**
- **Note**: Pay2S doesn't sign amount per-transaction — relies solely on Bearer + IP. Our defense must rely on Bearer + optional IP whitelist.

### ATK-M04 — Concurrent purchase same plan, insufficient balance
- **Target**: Debit race condition
- **Attack**: User has 50,000 VND. Plan costs 50,000. User sends 10 parallel purchase requests. Only 1 must succeed.
- **How**:
  ```bash
  # Seed user with exactly 50000
  for i in {1..10}; do
    curl -X POST /api/subscriptions/purchase \
      -H "Authorization: Bearer $TOKEN" \
      -d '{"plan_id":1,"billing_cycle":"monthly"}' &
  done
  wait
  # Check: should have 1 subscription, balance 0, NOT 10 subscriptions
  ```
- **Expected defense**: `SELECT FOR UPDATE` serializes. 1 success, 9 fail with `INSUFFICIENT_BALANCE`.
- **Failure signal**: 2+ subscriptions created, balance negative. **CRITICAL.**

### ATK-M05 — Discount code abuse via parallel use
- **Target**: Discount code usage counter
- **Attack**: Discount limited to 10 uses total. Submit 50 concurrent purchases with the code.
- **How**:
  ```bash
  for i in {1..50}; do
    curl -X POST /api/subscriptions/purchase \
      -H "Authorization: Bearer $TOKEN_$i" \
      -d '{"plan_id":1,"billing_cycle":"monthly","discount_code":"LIMIT10"}' &
  done
  wait
  # Check: discount_codes.used_count should be exactly 10
  ```
- **Expected defense**: Atomic increment (e.g., UPDATE with WHERE used_count < usage_limit) or row lock.
- **Failure signal**: used_count > 10, OR 50 purchases all got discount. **HIGH.**

### ATK-M06 — Discount per-user limit bypass
- **Target**: Per-user discount limit
- **Attack**: Code with `usage_limit_per_user=1`. Same user submits 10 concurrent purchases.
- **How**: Same as M05 but same user token.
- **Expected defense**: Only first purchase applies discount.
- **Failure signal**: Multiple purchases get discount. **MEDIUM.**

### ATK-M07 — Billing cron run twice same day (server restart mid-run)
- **Target**: Billing engine idempotency
- **Attack**: Simulate: trigger billing-engine → kill mid-run → restart → it runs again.
- **How**:
  ```bash
  # Script that triggers billing, sleeps 2s, kills process
  node -e "require('./src/jobs/billing-engine').run()" & 
  PID=$!
  sleep 2
  kill -9 $PID
  node -e "require('./src/jobs/billing-engine').run()"
  # Check: subscriptions should be renewed ONCE, not twice
  ```
- **Expected defense**: Idempotency key `renewal:${sub_id}:${period_end}` prevents double-charge.
- **Failure signal**: Users charged twice for same period. **CRITICAL.**

### ATK-M08 — Purchase with client-supplied price
- **Target**: Purchase endpoint input validation
- **Attack**: User submits purchase with `price: 1` trying to override plan price.
- **How**:
  ```bash
  curl -X POST /api/subscriptions/purchase \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"plan_id":3,"billing_cycle":"monthly","price":1,"total":1,"amount":1}'
  ```
- **Expected defense**: Server reads price from `service_plans` table, ignores client fields.
- **Failure signal**: Subscription created at 1 VND. **CRITICAL.**

### ATK-M09 — Upgrade with wrong arithmetic (prorated credit inflation)
- **Target**: Upgrade proration
- **Attack**: User buys Starter, next day upgrades to Pro. Attacker hopes prorated "credit" is more than charge.
- **How**: Check the upgrade formula. The unused portion should be: `unused_days / total_days * old_plan_price`. Attacker can't inflate this (it's server-computed), but test the formula for edge cases:
  - Upgrade 1 second after purchase → credit ≈ full old price
  - Upgrade at moment of expiry → credit ≈ 0
- **Expected defense**: Formula uses server time, plan prices from DB, correct math.
- **Failure signal**: Credit exceeds old plan price, or charge is negative. **HIGH.**

### ATK-M10 — Admin balance-adjust without audit
- **Target**: Admin balance adjust endpoint
- **Attack**: Admin adjusts balance without writing audit log (code path exists that skips it).
- **How**: Review code. Can any path update `users.balance` for admin purposes without inserting `admin_audit_log`?
- **Expected defense**: All admin balance ops go through single function that writes audit in same transaction.
- **Failure signal**: Code review reveals direct SQL update. **HIGH.**

### ATK-M11 — Transaction log tampering
- **Target**: Transaction immutability
- **Attack**: Can `wallet_transactions` rows be UPDATEd or DELETEd?
- **How**: Code review for any UPDATE/DELETE on `wallet_transactions`. Should be NONE in application code.
- **Expected defense**: Only INSERTs. DB user could be restricted from UPDATE/DELETE on this table (future).
- **Failure signal**: Code path that modifies existing transactions. **HIGH.**

### ATK-M12 — Float-creep in arithmetic
- **Target**: Money arithmetic
- **Attack**: Deposit 100 transactions of 99.99 VND each. Expected: 9999 VND balance. If using float, might drift.
- **How**:
  ```bash
  # Seed test: 100 credits of 99.99
  for i in {1..100}; do
    # Internal helper, not HTTP
    node -e "require('./src/modules/wallet/service').credit(1, 99.99, {type:'bonus',idempotencyKey:'test'+$i})"
  done
  # Final balance must be 9999.00 exactly
  ```
- **Expected defense**: Decimal arithmetic. Result exact.
- **Failure signal**: Balance is 9998.9999..., 9999.0001, etc. **HIGH (fintech integrity).**

---

## 🧨 ATK-I: Injection Attacks

### ATK-I01 — SQL injection in search
- **Target**: Any endpoint accepting search query
- **Attack**: `GET /api/admin/users?q=' OR 1=1 --`
- **How**:
  ```bash
  curl "http://localhost:3000/api/admin/users?q=' OR 1=1 --" -H "Authorization: Bearer $ADMIN_TOKEN"
  curl "http://localhost:3000/api/admin/users?q=%27%3B%20DROP%20TABLE%20users%20--" -H "Authorization: Bearer $ADMIN_TOKEN"
  ```
- **Expected defense**: Parameterized query. Search treats input as literal string.
- **Failure signal**: Full user list returned, OR 500 error with SQL parse error, OR table dropped. **CRITICAL.**

### ATK-I02 — SQL injection in pagination/ordering
- **Target**: `?order_by=` or `?sort=` params (if implemented)
- **Attack**: `?order_by=id; DROP TABLE users--`
- **How**: Submit with malicious order_by.
- **Expected defense**: Whitelist of allowed sort columns. Reject anything else.
- **Failure signal**: 500 error, or table affected. **CRITICAL.**

### ATK-I03 — XSS via email content
- **Target**: Any page that displays user-submitted email/name
- **Attack**: Register with email `"><script>alert(1)</script>"@test.com` (if email validation lax) or name field with HTML.
- **How**:
  ```bash
  # Register user with XSS payload in display name (if such field exists)
  curl -X POST /api/auth/register -d '{"email":"test@test.com","password":"ValidPass123","display_name":"<script>alert(document.cookie)</script>"}'
  # Then view on admin page; script should NOT execute
  ```
- **Expected defense**: EJS `<%= %>` auto-escapes. Content-Security-Policy blocks inline scripts.
- **Failure signal**: Alert fires, or DOM contains unescaped `<script>`. **HIGH.**

### ATK-I04 — XSS via monitor name/target
- **Target**: Monitor display pages
- **Attack**: Create monitor with name `<img src=x onerror=alert(1)>` and view it.
- **How**:
  ```bash
  curl -X POST /api/monitors -d '{"name":"<img src=x onerror=alert(1)>","type":"http","target":"https://test.com"}'
  # View /dashboard or /monitors/:id in browser
  ```
- **Expected defense**: Escaped on render.
- **Failure signal**: Script executes. **HIGH.**

### ATK-I05 — XSS in Telegram/email rendering
- **Target**: Telegram messages, email HTML
- **Attack**: Monitor name with HTML → shows up in alert → raw HTML sent to Telegram/email.
- **How**: Monitor name `<b>hacked</b>`. When alert fires, Telegram message should contain literal `<b>hacked</b>` text (escaped), NOT formatted bold.
- **Expected defense**: Telegram HTML mode escapes user input; email templates escape too.
- **Failure signal**: Telegram shows bold text or executes links injected via user content. **MEDIUM.**

### ATK-I06 — SSRF via monitor target
- **Target**: Monitor HTTP check
- **Attack**: Create HTTP monitor with target `http://169.254.169.254/latest/meta-data/` (AWS metadata) or `http://127.0.0.1:3000/api/admin/users`.
- **How**:
  ```bash
  curl -X POST /api/monitors -d '{"name":"ssrf-test","type":"http","target":"http://169.254.169.254/"}'
  # Wait for check. Check monitor_checks for response content.
  ```
- **Expected defense**: Target validation rejects private IP ranges before creating monitor. Or at check time, resolve target and refuse private IPs.
- **Failure signal**: Monitor successfully checks internal IP, returns content. **CRITICAL on cloud, HIGH otherwise.**

### ATK-I07 — SSRF via redirects
- **Target**: HTTP check following redirects
- **Attack**: Target is `https://evil.com/redirect` which responds 302 → `http://127.0.0.1:3000/admin/...`.
- **How**: Set up or simulate redirect target. Ensure HTTP client either doesn't follow redirects, or re-validates each URL in the chain.
- **Expected defense**: Either `follow: false` or URL validator called per hop.
- **Failure signal**: Final URL is internal. **HIGH.**

### ATK-I08 — SSRF via DNS rebinding
- **Target**: HTTP check DNS resolution
- **Attack**: Attacker-controlled DNS returns public IP first time, private IP on second resolution. Validator checks first, fetcher uses second.
- **How**: Hard to test without DNS setup. Document that we cache resolved IP (don't re-resolve between validate and fetch) OR pass resolved IP to HTTP client explicitly.
- **Expected defense**: Resolve once, use resolved IP for validation AND fetch.
- **Failure signal**: Code path where validator and fetcher do separate DNS lookups. **MEDIUM.**

### ATK-I09 — Oversized response from monitored target
- **Target**: HTTP check response handling
- **Attack**: Target returns 1 GB response. Our checker OOM.
- **How**: Set up target that streams infinite data. Or simulate with test server.
- **Expected defense**: Max response size (e.g., 5 MB for keyword check, 1 KB for basic uptime). Abort connection on exceed.
- **Failure signal**: Node process memory spikes, or crashes. **HIGH (DoS).**

### ATK-I10 — Command injection via user input
- **Target**: Any place we call shell (ping, curl)
- **Attack**: Monitor target `127.0.0.1; rm -rf /` for ping check.
- **How**: If ping implementation uses `execFile`, arg is safe. If uses `exec` or `spawn with shell:true`, arg is interpreted.
- **Expected defense**: `execFile('ping', [sanitizedTarget])` without shell.
- **Failure signal**: Shell metacharacters executed. **CRITICAL.**

### ATK-I11 — Path traversal in file downloads
- **Target**: Invoice PDF download endpoint
- **Attack**: `GET /api/invoices/../../../etc/passwd`
- **How**:
  ```bash
  curl "http://localhost:3000/api/invoices/%2e%2e%2f%2e%2e%2fetc%2fpasswd" -H "Authorization: Bearer $TOKEN"
  ```
- **Expected defense**: ID validated as positive integer. Any non-integer returns 400.
- **Failure signal**: File outside invoice directory served. **CRITICAL.**

### ATK-I12 — Prototype pollution via request body
- **Target**: Express body parsing + object merge operations
- **Attack**: Submit body `{"__proto__":{"isAdmin":true}}` or `{"constructor":{"prototype":{"isAdmin":true}}}`.
- **How**:
  ```bash
  curl -X PATCH /api/me \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"email":"x@test.com","__proto__":{"role":"admin"}}'
  ```
- **Expected defense**: zod strict parsing rejects unknown keys. No use of `Object.assign` with user input on sensitive objects.
- **Failure signal**: Global object polluted, role escalated. **HIGH.**

---

## 🔐 ATK-D: Authorization & IDOR

### ATK-D01 — Access another user's monitor
- **Target**: Monitor endpoints
- **Attack**: User A creates monitor (ID=5). User B tries to access `/api/monitors/5`.
- **How**:
  ```bash
  curl -H "Authorization: Bearer $USER_B_TOKEN" /api/monitors/5
  curl -X PATCH -H "Authorization: Bearer $USER_B_TOKEN" /api/monitors/5 -d '...'
  curl -X DELETE -H "Authorization: Bearer $USER_B_TOKEN" /api/monitors/5
  ```
- **Expected defense**: 404 (preferred, no enumeration) or consistent 403.
- **Failure signal**: 200 with monitor data, or PATCH/DELETE succeeds. **CRITICAL.**

### ATK-D02 — Access another user's invoice
- **Target**: Invoice endpoints
- **Attack**: Enumerate invoice IDs.
- **How**: Loop over IDs, check response.
- **Expected defense**: Only own invoices accessible.
- **Failure signal**: Other users' invoices readable. **HIGH (data leak).**

### ATK-D03 — Access another user's wallet transactions
- **Target**: Wallet transactions list
- **Attack**: Pass `user_id` query param hoping for bypass.
- **How**:
  ```bash
  curl -H "Authorization: Bearer $USER_B_TOKEN" "/api/wallet/transactions?user_id=<USER_A_ID>"
  ```
- **Expected defense**: Server ignores user_id param, uses JWT sub.
- **Failure signal**: Sees other user's transactions. **HIGH.**

### ATK-D04 — Subscription modification cross-user
- **Target**: Subscription endpoints
- **Attack**: Cancel another user's subscription.
- **How**: Call `/api/subscriptions/:id/cancel` with wrong user's token.
- **Expected defense**: 404.
- **Failure signal**: Cancellation succeeds. **HIGH.**

### ATK-D05 — Admin endpoint hit by non-admin
- **Target**: All `/api/admin/*` routes
- **Attack**: Normal user token attempts each admin endpoint.
- **How**: Test script iterating admin endpoint list.
- **Expected defense**: 403 on all.
- **Failure signal**: Any endpoint returns data. **CRITICAL.**

### ATK-D06 — Admin role assigned to self via /api/me
- **Target**: User profile update
- **Attack**: As already documented in ATK-A07.

### ATK-D07 — Enumerate users via ID
- **Target**: Any `/api/users/:id` pattern
- **Attack**: Loop IDs 1-10000, see responses.
- **How**:
  ```bash
  for i in {1..100}; do
    echo "$(curl -so /dev/null -w '%{http_code}' /api/users/$i -H 'Authorization: Bearer $TOKEN') $i"
  done
  ```
- **Expected defense**: Any public user endpoint should not reveal user existence (404 consistent for valid/invalid IDs).
- **Failure signal**: 403 for existing users vs 404 for nonexistent — enumeration possible. **MEDIUM.**

### ATK-D08 — Monitor creation beyond plan quota
- **Target**: Monitor creation quota
- **Attack**: User with Starter plan (1 monitor) creates 2 monitors via parallel requests.
- **How**:
  ```bash
  for i in {1..5}; do
    curl -X POST /api/monitors -H "Authorization: Bearer $STARTER_TOKEN" -d '{"name":"m'$i'","type":"http","target":"https://test.com"}' &
  done
  wait
  ```
- **Expected defense**: Count lock or SELECT FOR UPDATE on subscription. Only 1 created, 4 rejected.
- **Failure signal**: 2+ monitors created. **MEDIUM (resource abuse).**

---

## 🌊 ATK-R: Rate Limit Bypass

### ATK-R01 — Change IP to bypass rate limit
- **Target**: IP-based rate limiting
- **Attack**: Spoof `X-Forwarded-For` on each request.
- **How**:
  ```bash
  for i in {1..100}; do
    curl -X POST /api/auth/login \
      -H "X-Forwarded-For: 1.2.3.$i" \
      -d '...'
  done
  ```
- **Expected defense**: Nginx sets correct `$remote_addr`, Node trusts only Nginx's real IP. `trust proxy` config points to Nginx only.
- **Failure signal**: 100 requests all succeed. **MEDIUM/HIGH.**

### ATK-R02 — Distributed brute force
- **Target**: Login brute force via botnet simulation
- **Attack**: 100 different IPs each try 3 passwords (under IP rate limit) against same user.
- **How**: Same as R01 but 3 requests per IP.
- **Expected defense**: Account lockout (per-account, not per-IP) kicks in regardless of source.
- **Failure signal**: 300 attempts against same account succeed. **HIGH.**

### ATK-R03 — Slow-loris style against webhook
- **Target**: Pay2S webhook endpoint
- **Attack**: Send webhook with incomplete body, keep connection open.
- **How**: Simulate with `telnet` or crafted HTTP client.
- **Expected defense**: Nginx timeout settings close slow connections (e.g., `client_body_timeout 10s`).
- **Failure signal**: Server exhausts connection pool. **MEDIUM.**

### ATK-R04 — Email queue flood
- **Target**: Email enqueue operations (e.g., forgot-password)
- **Attack**: 1000 forgot-password requests for same email → 1000 emails queued.
- **How**: 
  ```bash
  for i in {1..1000}; do
    curl -X POST /api/auth/forgot-password -d '{"email":"target@test.com"}' &
  done
  wait
  ```
- **Expected defense**: Per-email rate limit (3/hour). Existing pending reset email → no new one queued.
- **Failure signal**: 1000 emails in queue. **MEDIUM (email quota depletion).**

---

## 📡 ATK-N: Network & Transport

### ATK-N01 — Force HTTP downgrade
- **Target**: Nginx HTTP→HTTPS redirect
- **Attack**: Post sensitive data to http://monitoring.vpsmmo.vn/api/auth/login.
- **How**:
  ```bash
  curl http://monitoring.vpsmmo.vn/api/auth/login -d '...' --no-location-trusted
  ```
- **Expected defense**: Nginx returns 301 immediately. Post body not leaked.
- **Failure signal**: HTTP accepts login and processes. **CRITICAL (password in plaintext on wire).**

### ATK-N02 — Stolen cookie replay without secure flag
- **Target**: Cookie security flags
- **Attack**: Inspect cookies in browser. Must be `httpOnly`, `secure`, `sameSite=strict`.
- **How**: Login, inspect Set-Cookie header in response.
- **Expected defense**: All three flags present on refresh token cookie.
- **Failure signal**: Missing flag. **MEDIUM-HIGH.**

### ATK-N03 — CORS wildcard abuse
- **Target**: CORS config
- **Attack**: Call API from evil.com via fetch with `credentials: include`.
- **How**:
  ```bash
  curl -H "Origin: https://evil.com" /api/me -v | grep "Access-Control"
  ```
- **Expected defense**: No `Access-Control-Allow-Origin: *` or echoed origin. Only same-origin or explicit whitelist.
- **Failure signal**: Evil.com can read responses. **HIGH.**

### ATK-N04 — Missing security headers
- **Target**: HTTP response headers
- **Attack**: Inspect headers for X-Frame-Options, X-Content-Type-Options, HSTS, CSP.
- **How**:
  ```bash
  curl -I https://monitoring.vpsmmo.vn
  ```
- **Expected defense**: All present per SEC-N03.
- **Failure signal**: Any missing. **LOW-MEDIUM depending on which.**

---

## 🪝 ATK-W: Webhook-Specific

### ATK-W01 — Webhook without Authorization header
- **Target**: Pay2S webhook endpoint
- **Attack**: POST valid-looking payload with no Auth header.
- **How**:
  ```bash
  curl -X POST /api/webhook/pay2s -d '{"transactions":[...]}' 
  ```
- **Expected defense**: 401.
- **Failure signal**: Processed. **CRITICAL.**

### ATK-W02 — Webhook with wrong Bearer
- **Target**: Pay2S webhook endpoint
- **Attack**: POST with Bearer of random string.
- **How**:
  ```bash
  curl -X POST /api/webhook/pay2s -H "Authorization: Bearer wrong_token" -d '...'
  ```
- **Expected defense**: 401, constant-time compare (no timing leak).
- **Failure signal**: Processed, or timing difference reveals correct chars. **CRITICAL.**

### ATK-W03 — Webhook timing attack on secret
- **Target**: Bearer token comparison
- **Attack**: If comparison is non-constant-time (`===` or `==` or `String.equals`), timing reveals characters.
- **How**: Micro-benchmark with secret guesses prefixed correctly vs wrong.
- **Expected defense**: `crypto.timingSafeEqual` used.
- **Failure signal**: Timing varies by character match. **HIGH.**

### ATK-W04 — Webhook with OUT transaction + memo
- **Target**: Transfer type filter
- **Attack**: Send webhook with `transferType: "OUT"` but valid memo. Hope code processes it.
- **How**: Craft payload.
- **Expected defense**: OUT ignored.
- **Failure signal**: Credit issued. **CRITICAL.**

### ATK-W05 — Webhook amount below minimum
- **Target**: MIN_TOPUP_VND filter
- **Attack**: Send 100 VND transaction.
- **How**: Craft payload with transferAmount=100.
- **Expected defense**: Logged, not credited.
- **Failure signal**: Credit issued. **MEDIUM (can be used to pollute tx history).**

### ATK-W06 — Bank account not in whitelist
- **Target**: Account number verification
- **Attack**: Webhook with `accountNumber` not in `PAY2S_BANK_ACCOUNTS` env.
- **How**: Craft payload.
- **Expected defense**: Treated as unmatched, not credited.
- **Failure signal**: Credited. **HIGH.**

### ATK-W07 — Crafted memo matching admin user
- **Target**: Memo parser
- **Attack**: Normal attacker transfers 10,000 VND with memo `VPSMMO1` (assuming admin is user ID 1) to credit admin account.
- **How**: Real bank transfer (costs real money but possible).
- **Expected defense**: This is legit — admin credits like anyone else. But flag if admin receives money via Pay2S, alert for review.
- **Note**: Not exploitable beyond annoyance (admin doesn't benefit from extra balance unless they spend it).
- **Failure signal**: N/A (accepted behavior).

### ATK-W08 — Memo with multiple VPSMMO patterns
- **Target**: Memo parser regex
- **Attack**: Content = `VPSMMO123 forwarded from VPSMMO456`.
- **How**: Craft webhook content.
- **Expected defense**: Takes first match (documented behavior).
- **Failure signal**: Credits wrong user, or both, or none. **MEDIUM.**

### ATK-W09 — Webhook signature via path traversal or param
- **Target**: Webhook route
- **Attack**: Try `POST /api/webhook/pay2s/../auth/login`.
- **How**:
  ```bash
  curl -X POST /api/webhook/pay2s/../auth/login
  ```
- **Expected defense**: Express router doesn't allow. 404 or route not matched.
- **Failure signal**: Hits auth endpoint without Bearer check. **MEDIUM.**

### ATK-W10 — Batch with duplicate checksums within
- **Target**: Webhook batch processing
- **Attack**: Payload has `transactions: [{checksum:"abc",...}, {checksum:"abc",...}]`.
- **How**: Craft payload with duplicate checksums.
- **Expected defense**: Second insert fails UNIQUE constraint, caught, skipped. First is credited.
- **Failure signal**: Both credited. **HIGH.**

---

## 🏗️ ATK-O: Ops & Infrastructure

### ATK-O01 — `.env` readable by nginx user
- **Attack**: Check if nginx user can read .env.
- **How**:
  ```bash
  sudo -u nginx cat /root/vpsmmo-monitoring/.env
  ```
- **Expected defense**: Permission denied (600 perm, owner-only).
- **Failure signal**: Contents shown. **CRITICAL.**

### ATK-O02 — Secrets in process environment exposed via /proc
- **Attack**: Any user reads `/proc/<pid>/environ`.
- **How**: `cat /proc/$(pgrep node)/environ`.
- **Expected defense**: Only readable by process owner. Node should NOT run as world-readable user.
- **Failure signal**: Other users can read. **CRITICAL.**

### ATK-O03 — Backup files world-readable
- **Attack**: Check `/var/backups/vpsmmo-monitoring/`.
- **How**: `ls -la /var/backups/vpsmmo-monitoring/`.
- **Expected defense**: 700 on dir, 600 on files, root-owned.
- **Failure signal**: World/group readable. **CRITICAL.**

### ATK-O04 — Open ports beyond expected
- **Attack**: Port scan from internet.
- **How**:
  ```bash
  nmap -p- monitoring.vpsmmo.vn
  ```
- **Expected defense**: Only 22 (ideally non-default), 80, 443.
- **Failure signal**: MySQL (3306), Node (3000), Redis, etc. exposed. **CRITICAL.**

### ATK-O05 — PM2 web UI exposed
- **Attack**: `curl :9615` or similar PM2 default port.
- **How**: Scan.
- **Expected defense**: PM2 monitoring NOT on public interface.
- **Failure signal**: Exposed. **HIGH.**

### ATK-O06 — `node_modules` and package files exposed via Nginx
- **Attack**: `curl /node_modules/.../package.json`.
- **How**: Direct request.
- **Expected defense**: Nginx only proxies to /api/ and /static. Root serves only public/.
- **Failure signal**: Returns file. **MEDIUM.**

---

# 📊 Report Template — SECURITY-AUDIT-REPORT.md

After Phase 9, produce this report:

```markdown
# SECURITY-AUDIT-REPORT.md

## Execution summary
- Date of audit: YYYY-MM-DD
- Duration: X hours
- Tests executed: X / Y total
- Tests skipped: X (with reasons)

## Findings by severity

### Critical (count: X)
- ATK-XX: <title>
  - What I tried: <brief>
  - Result: <vulnerable|safe>
  - Evidence: <logs, screenshots, code refs>
  - Fix applied: <commit hash or file changes>
  - Re-test result: <pass|pending>

### High (count: X)
...

### Medium (count: X)
...

### Low (count: X)
...

## Accepted risks
- Risk 1: <description>
  - Why accepted: <reason>
  - Mitigation in place: <controls>
  - Human approval: <yes/no>

## Recommendations deferred to Phase 11+
- ...

## Metrics
- Money-path test coverage: XXX%
- Total security test count: X
- CVEs patched in deps: X
- Npm audit level: <clean|high|critical>

## Sign-off
- Audit performed by: Claude Code
- Reviewed by human: [ ] yes / [ ] no
- Approved for launch: [ ] yes / [ ] no
```

---

# 🛡️ Defensive Coding Patterns (prevent attacks upfront)

While writing code in earlier phases, apply these patterns to prevent attacks preemptively:

## Pattern P1: "Deny by default"
Every new endpoint starts with authentication required. Mark as public explicitly if needed.

## Pattern P2: "Validate at the edge"
Every HTTP handler starts with `schema.parse(req.body)`. No ad-hoc checking inside business logic.

## Pattern P3: "Trust no one, verify everything"
Every query that reads or writes a user's data MUST include `user_id = req.user.id` in WHERE clause.

## Pattern P4: "Audit trail = insurance"
Every admin action writes to `admin_audit_log` in same transaction. No exceptions.

## Pattern P5: "Fail closed"
On any exception in money path, rollback and reject. Never continue with partial state.

## Pattern P6: "Defense in depth"
Don't rely on any single check. Nginx + Express middleware + Business logic all enforce.

---

# 🧠 Mental model: "What would a smart attacker try next?"

When you finish implementing a feature, before claiming done, ask:

1. **What's the unspoken assumption in this code?** (e.g., "amount is positive")
   → Can that assumption be violated by an attacker?

2. **What if this runs twice?**
   → Is it idempotent?

3. **What if this runs in parallel?**
   → Are there races?

4. **What if the external service (Pay2S, Gmail, Telegram) is lying or compromised?**
   → Do we verify? Rate-limit? Log?

5. **What does this code reveal to an observer?** (timing, error messages, response sizes)
   → Is there an enumeration vector?

6. **If I were desperate and had 48 hours, how would I exploit this?**
   → Actually try it.

---

# 🚨 Red flags that indicate a phase is NOT done

Watch for these patterns in your own work:

- "This is rare, we can handle it later" → HANDLE IT NOW
- "It only happens in testing" → SOMEONE WILL REPRODUCE IT IN PROD
- "The tests pass" → CHECK SECURITY-CHECKLIST + THIS DOC
- "I disabled the check because..." → RE-ENABLE
- "This function is private, no one can call it externally" → TESTING FRAMEWORK CAN
- "The probability is very low" → OPPONENT HAS ALL DAY

---

# 🔚 Final note

A system that hasn't been attacked is a system whose vulnerabilities are unknown, not absent.

You are now the attacker.

Write the report. Fix what you find. Document what you accept. Escalate what you can't resolve.

**When in doubt, assume the attacker is smarter than you and has more time.**

— End of ADVERSARIAL-TESTING.md —

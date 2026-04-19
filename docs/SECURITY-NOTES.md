# Security Notes — Accepted Risks & Known Limitations

## ATK-A03: Access token valid for 15 minutes after logout

### Risk description
When a user logs out, we revoke their refresh token (session row in
user_sessions marked revoked=true). However, the **access token** they
hold in memory remains valid until its 15-minute expiration (JWT is
stateless, cannot be invalidated server-side without a blacklist).

### Attack scenario
If an attacker obtains an access token (e.g., via browser devtools, XSS,
or memory dump), they can use it for up to 15 minutes even after the
legitimate user logs out.

### Why accepted
- Industry-standard pattern for stateless JWT
- 15-minute TTL is already aggressive (many apps use 1 hour)
- Full invalidation requires a token blacklist (Redis or DB), adding
  infrastructure complexity
- Refresh token revocation prevents session continuation

### Current mitigations
1. Short-lived access token (15 min, per CLAUDE.md §2.5)
2. HttpOnly + Secure + SameSite=strict cookies (prevents JS access)
3. CSP headers restrict inline scripts (Phase 8)
4. Refresh token rotation detects compromise (reuse → revoke all)

### Future hardening (post-MVP)
- Add Redis-based access token blacklist (15-min TTL entries, low memory)
- Implement session_id claim in access JWT + blacklist by session_id
- Short-circuit in auth middleware if session_id is blacklisted

### Severity: LOW

---

## Email delivery depends on Gmail SMTP quota (500/day free)

### Risk
If email queue exceeds 450/day (hard cap), new emails are blocked. User
cannot verify email or reset password until next day.

### Mitigations
1. Daily quota check (WARN admin at 320, STOP at 450)
2. Queue preserves emails (not lost, retryable next day)
3. Critical flows (password reset) have priority=1 in queue

### Future hardening
- Migrate to Resend/SendGrid when user count > 500
- Multi-provider fallback

### Severity: LOW-MEDIUM (depends on user growth rate)

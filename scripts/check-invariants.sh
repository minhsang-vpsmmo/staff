#!/bin/bash
# Verify wallet invariants. Run after every money-path test/deploy.
set -e
cd "$(dirname "$0")/.."

# Parse .env via node (handles spaces in values)
DB_CREDS=$(node -e "require('dotenv').config(); var e=process.env; process.stdout.write(e.DB_USER+'|'+e.DB_PASSWORD+'|'+e.DB_NAME)")
DB_USER=$(echo "$DB_CREDS" | cut -d'|' -f1)
DB_PASSWORD=$(echo "$DB_CREDS" | cut -d'|' -f2)
DB_NAME=$(echo "$DB_CREDS" | cut -d'|' -f3)

FAIL=0

echo "=== Invariant 1: SUM(transactions) = users.balance ==="
RESULT=$(mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -N -e "
  SELECT COUNT(*) FROM (
    SELECT u.id, u.balance, COALESCE(SUM(wt.amount), 0) AS txn_sum
    FROM users u LEFT JOIN wallet_transactions wt ON u.id = wt.user_id
    GROUP BY u.id
    HAVING u.balance != COALESCE(SUM(wt.amount), 0)
  ) t;
" 2>/dev/null)
echo "Broken users: $RESULT"
if [ "$RESULT" != "0" ]; then
  echo "❌ VIOLATION: $RESULT users have mismatched balance"
  FAIL=1
fi

echo ""
echo "=== Invariant 2: No duplicate idempotency_key ==="
DUP_IDEM=$(mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -N -e "
  SELECT COUNT(*) FROM (
    SELECT idempotency_key FROM wallet_transactions
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key HAVING COUNT(*) > 1
  ) t;
" 2>/dev/null)
echo "Duplicate idempotency keys: $DUP_IDEM"
if [ "$DUP_IDEM" != "0" ]; then
  echo "❌ VIOLATION: duplicate idempotency keys found"
  FAIL=1
fi

echo ""
echo "=== Invariant 3: No orphan transactions ==="
ORPHAN=$(mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -N -e "
  SELECT COUNT(*) FROM wallet_transactions wt
  LEFT JOIN users u ON wt.user_id = u.id WHERE u.id IS NULL;
" 2>/dev/null)
echo "Orphan transactions: $ORPHAN"
if [ "$ORPHAN" != "0" ]; then
  echo "❌ VIOLATION: orphan transactions found"
  FAIL=1
fi

echo ""
if [ $FAIL -eq 0 ]; then
  echo "✅ All 3 invariants OK"
  exit 0
else
  echo "❌ INVARIANT VIOLATIONS DETECTED"
  exit 1
fi

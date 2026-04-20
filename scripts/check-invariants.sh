#!/bin/bash
# Verify wallet balance invariant: SUM(wallet_transactions.amount) = users.balance
set -e
cd "$(dirname "$0")/.."

# Parse .env via node (handles spaces in values like Gmail App Password)
DB_CREDS=$(node -e "require('dotenv').config(); var e=process.env; process.stdout.write(e.DB_USER+'|'+e.DB_PASSWORD+'|'+e.DB_NAME)")
DB_USER=$(echo "$DB_CREDS" | cut -d'|' -f1)
DB_PASSWORD=$(echo "$DB_CREDS" | cut -d'|' -f2)
DB_NAME=$(echo "$DB_CREDS" | cut -d'|' -f3)

RESULT=$(mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -N -e "
  SELECT COUNT(*) AS broken_users FROM (
    SELECT u.id, u.balance,
           COALESCE(SUM(wt.amount), 0) AS txn_sum
    FROM users u
    LEFT JOIN wallet_transactions wt ON u.id = wt.user_id
    GROUP BY u.id
    HAVING u.balance != COALESCE(SUM(wt.amount), 0)
  ) t;
" 2>/dev/null)

echo "Broken users: $RESULT"
if [ "$RESULT" = "0" ]; then
  echo "✅ Wallet invariant OK"
  exit 0
else
  echo "❌ INVARIANT VIOLATION: $RESULT users have mismatched balance"
  exit 1
fi

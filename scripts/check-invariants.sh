#!/bin/bash
# Verify wallet balance invariant: SUM(wallet_transactions.amount) = users.balance
set -e
source .env 2>/dev/null || true
RESULT=$(mysql -u "${DB_USER:-vpsmmo_monitoring}" -p"${DB_PASSWORD}" "${DB_NAME:-vpsmmo_monitoring}" -N -e "
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

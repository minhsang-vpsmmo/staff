#!/bin/bash
# Find SELECT queries without user_id filter in modules that should have it
set -e
LEAKS=$(grep -rnE "SELECT .* FROM (monitors|invoices|user_subscriptions|wallet_transactions)" src/modules/ 2>/dev/null | grep -v "user_id\|admin\|\.test\." || true)
if [ -n "$LEAKS" ]; then
  echo "⚠️ Possible owner-leak queries (missing user_id filter):"
  echo "$LEAKS"
  exit 1
else
  echo "✅ No owner-leak queries found"
  exit 0
fi

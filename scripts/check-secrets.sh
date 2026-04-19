#!/bin/bash
# Scan src/ for accidentally committed secrets
set -e
FOUND=0
PATTERNS=(
  "AIzaSy"
  "sk_live_"
  "sk_test_"
  "BEGIN PRIVATE KEY"
  "BEGIN RSA PRIVATE KEY"
)
for pattern in "${PATTERNS[@]}"; do
  MATCHES=$(grep -rnF "$pattern" src/ 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    echo "❌ Found secret pattern :"
    echo "$MATCHES"
    FOUND=1
  fi
done
# Regex patterns
REGEX_MATCHES=$(grep -rnE "password\s*[:=]\s*[\"'][^\"']{8,}" src/ 2>/dev/null | grep -v "password_hash\|password_min\|password_reset\|password_hash\|\.example\|\.test\." || true)
if [ -n "$REGEX_MATCHES" ]; then
  echo "❌ Possible hardcoded password:"
  echo "$REGEX_MATCHES"
  FOUND=1
fi
if [ $FOUND -eq 0 ]; then
  echo "✅ No secrets found in src/"
fi
exit $FOUND

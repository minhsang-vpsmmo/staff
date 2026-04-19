#!/bin/bash
# Run npm audit, fail on high/critical
npm audit --audit-level=high 2>&1
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "❌ npm audit found high/critical vulnerabilities"
else
  echo "✅ npm audit clean"
fi
exit $EXIT

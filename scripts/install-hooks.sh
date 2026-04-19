#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Error: not a git repository"; exit 1
fi

cp "$REPO_DIR/.git-hooks/pre-commit" "$REPO_DIR/.git/hooks/pre-commit"
chmod +x "$REPO_DIR/.git/hooks/pre-commit"
echo "✅ Pre-commit hook installed"

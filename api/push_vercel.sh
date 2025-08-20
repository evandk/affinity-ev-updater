#!/usr/bin/env bash
set -euo pipefail

# Path to your Vercel project
BASE_DIR="/Users/evan/Affinity Backfill/Vercel"

# Remote repo URL (override by passing as arg1)
REMOTE="${1:-https://github.com/evandk/affinity-ev-updater.git}"

# Commit message (override by passing as arg2)
COMMIT_MSG="${2:-chore: update Vercel webhook project}"

# Check if BASE_DIR exists
if [ ! -d "$BASE_DIR" ]; then
  echo "Error: Directory '$BASE_DIR' does not exist."
  exit 1
fi

cd "$BASE_DIR"

# Ensure we don't commit secrets
cat > .gitignore <<'EOF'
node_modules
.DS_Store
.env
**/.env
EOF

# Init repo (idempotent)
git init

# Set/replace origin
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

# Stage and commit
git add -A
git commit -m "$COMMIT_MSG" || true

# Use main branch
git branch -M main

# Rebase on remote main if it exists (ignore if not)
git pull --rebase origin main || true

# Push
git push -u origin main

#!/usr/bin/env bash
# Ship an update to the worker. Run ON THE VM:
#
#   ~/intern-finder-bot/apps/worker/deploy/update.sh
#
# This is what makes "you won't need to rebuild for Phase 2" true: Phase 2 adds
# files and one dependency, and this handles both.
#
# Unlike libstaffer-bot (manual scp of a single bot.py), this project is a
# TypeScript monorepo with a lockfile, so it pulls from git. Same idea, fewer
# moving parts to get wrong.

set -euo pipefail

APP_DIR="/home/ubuntu/intern-finder-bot"
SERVICE="intern-finder-worker"

cd "$APP_DIR"

echo "==> Current: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

echo "==> Pulling"
git pull --ff-only

echo "==> Installing dependencies"
# `npm ci` would be stricter, but it deletes and rebuilds node_modules from
# scratch, which is slow and memory-hungry on a 1 OCPU / 1GB box. `install`
# still respects the lockfile and only does the work that changed.
npm install --no-audit --no-fund

echo "==> Type checking before restart"
# Catch a broken pull here rather than in a restart loop. The worker runs
# straight from TypeScript via tsx, so a type error is a runtime error.
npx tsc -p tsconfig.json --noEmit

echo "==> Checking environment and schema"
npm run doctor

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 3
sudo systemctl status "$SERVICE" --no-pager --lines=15

echo
echo "==> Now at: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo "    Follow logs with: journalctl -u $SERVICE -f"

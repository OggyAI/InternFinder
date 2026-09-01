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

# `npm install` rewrites package-lock.json, so after the first deploy the VM has
# a modified tracked file and `git pull --ff-only` refuses to run. The lockfile
# is generated and the repo's copy is authoritative here, so discard it — but
# only it. Anything ELSE modified on a deploy target is a human having edited
# the server directly, which is worth stopping for rather than silently
# throwing away.
if ! git diff --quiet -- package-lock.json; then
  echo "==> Discarding locally-regenerated package-lock.json"
  git checkout -- package-lock.json
fi

OTHER_CHANGES="$(git status --porcelain --untracked-files=no)"
if [ -n "$OTHER_CHANGES" ]; then
  echo "!! This checkout has local modifications beyond the lockfile:"
  echo "$OTHER_CHANGES"
  echo "!! Refusing to pull over them. Commit, stash, or discard them first."
  exit 1
fi

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

# The unit file is version-controlled but installed by hand, so a change to it
# would otherwise sit in the repo doing nothing while the box keeps running the
# old one. Detect the drift and say so; installing it needs sudo and is a
# heavier action than a restart, so it stays a deliberate step.
UNIT_SRC="$APP_DIR/apps/worker/deploy/$SERVICE.service"
UNIT_DST="/etc/systemd/system/$SERVICE.service"
if [ -f "$UNIT_SRC" ] && ! diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
  echo
  echo "!! The systemd unit in the repo differs from the installed one:"
  diff "$UNIT_DST" "$UNIT_SRC" | sed 's/^/     /' || true
  echo
  echo "   To apply it:"
  echo "     sudo cp $UNIT_SRC $UNIT_DST"
  echo "     sudo systemctl daemon-reload"
  echo "   Continuing with the currently installed unit."
  echo
fi

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 3
sudo systemctl status "$SERVICE" --no-pager --lines=15

echo
echo "==> Now at: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo "    Follow logs with: journalctl -u $SERVICE -f"

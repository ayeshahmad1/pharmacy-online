#!/usr/bin/env bash
# Points `current` back at an earlier release and reloads the API. Run as the
# app user:
#
#   /opt/pharmacy-pos/current/deploy/scripts/rollback.sh            the release before current
#   /opt/pharmacy-pos/current/deploy/scripts/rollback.sh <release>  a named one (see `ls releases`)
#
# Only code is rolled back. If the newer release applied database migrations,
# the database stays at the newer schema; the script lists them and asks before
# going on. When the older code cannot run on that schema, restore the
# pre-deploy backup instead (README: "Rollback").
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/pharmacy-pos}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health/ready}"

log() { echo "$(date -Is) [rollback] $*"; }
fail() {
  log "ERROR: $*"
  exit 1
}

[[ "$(id -u)" -ne 0 ]] || fail "Run as the app user (sudo -iu pharmacy), not root."
exec 9>"$APP_ROOT/.deploy.lock"
flock -n 9 || fail "A deploy is running."

CURRENT="$(readlink -f "$APP_ROOT/current")"
if [[ $# -ge 1 ]]; then
  TARGET="$APP_ROOT/releases/$1"
else
  # Newest release older than the current one (names start with a timestamp).
  TARGET="$(ls -1d "$APP_ROOT"/releases/*/ | sed 's#/$##' | sort |
    awk -v cur="$CURRENT" '$0 == cur { print prev; exit } { prev = $0 }')"
fi
[[ -n "$TARGET" && -d "$TARGET" ]] || fail "No release to roll back to."
[[ "$TARGET" != "$CURRENT" ]] || fail "$(basename "$TARGET") is already current."

# Migrations the current release has and the target does not.
NEWER="$(comm -23 \
  <(ls -1 "$CURRENT/apps/api/prisma/migrations" | grep -v migration_lock | sort) \
  <(ls -1 "$TARGET/apps/api/prisma/migrations" | grep -v migration_lock | sort))"
if [[ -n "$NEWER" ]]; then
  echo "The database has migrations that $(basename "$TARGET") does not know about:"
  echo "$NEWER" | sed 's/^/  /'
  echo "Old code usually runs fine on an added column or table, but not on a removed or renamed one."
  read -r -p "Roll back the code anyway? [y/N] " answer
  [[ "$answer" == [yY] ]] || fail "Cancelled."
fi

log "Switching from $(basename "$CURRENT") to $(basename "$TARGET")"
ln -sfn "$TARGET" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
pm2 startOrReload "$APP_ROOT/current/ecosystem.config.cjs" --update-env

for _ in $(seq 1 30); do
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
    pm2 save >/dev/null
    log "Rolled back to $(basename "$TARGET")"
    exit 0
  fi
  sleep 1
done
fail "$(basename "$TARGET") is not healthy; check 'pm2 logs pharmacy-pos-api'."

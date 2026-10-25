#!/usr/bin/env bash
# Deploys a git ref as a new release, with automatic rollback if it fails its
# health check. Run as the app user on the server:
#
#   /opt/pharmacy-pos/current/deploy/scripts/deploy.sh [ref]     (default: main)
#
# (For the very first deploy, run it from the clone: /opt/pharmacy-pos/repo/deploy/scripts/deploy.sh)
#
# Steps: fetch -> export the ref into releases/<stamp>-<sha> -> install, build
# -> back up the database -> run migrations -> point `current` at the release
# -> reload PM2 -> wait for /api/health/ready. If the new release is not
# healthy, `current` goes back to the previous release and PM2 reloads it.
# Migrations are NOT undone (see "Rollback" in the README).
set -Eeuo pipefail

REF="${1:-main}"
APP_ROOT="${APP_ROOT:-/opt/pharmacy-pos}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health/ready}"
REPO="$APP_ROOT/repo"
SHARED="$APP_ROOT/shared"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

log() { echo "$(date -Is) [deploy] $*"; }
fail() {
  log "ERROR: $*"
  exit 1
}

[[ "$(id -u)" -ne 0 ]] || fail "Run as the app user (sudo -iu pharmacy), not root."
for f in "$SHARED/api.env" "$SHARED/web.env"; do
  [[ -f "$f" ]] || fail "Missing $f (see README: Configure)"
done

exec 9>"$APP_ROOT/.deploy.lock"
flock -n 9 || fail "Another deploy is running."

log "Fetching $REF"
git -C "$REPO" fetch --prune --tags origin
SHA="$(git -C "$REPO" rev-parse --verify --quiet "origin/$REF^{commit}" ||
  git -C "$REPO" rev-parse --verify --quiet "$REF^{commit}")" ||
  fail "Unknown ref: $REF"
RELEASE="$(date +%Y%m%d%H%M%S)-${SHA:0:7}"
DIR="$APP_ROOT/releases/$RELEASE"
PREVIOUS="$(readlink -e "$APP_ROOT/current" || true)"

log "Building release $RELEASE"
mkdir -p "$DIR"
git -C "$REPO" archive "$SHA" | tar -x -C "$DIR"
echo "$SHA" >"$DIR/REVISION"
# Prisma's CLI reads apps/api/.env; Vite reads apps/web/.env at build time.
ln -sfn "$SHARED/api.env" "$DIR/apps/api/.env"
ln -sfn "$SHARED/web.env" "$DIR/apps/web/.env"

cd "$DIR"
# Dev dependencies are needed to build (Vite, esbuild) and to run the Prisma CLI.
pnpm install --frozen-lockfile
pnpm --filter web build
pnpm --filter api build

if [[ -n "$PREVIOUS" ]]; then
  log "Backing up the database before migrating"
  "$DIR/deploy/scripts/backup-db.sh" pre-deploy
fi
log "Applying migrations"
pnpm --filter api db:deploy

switch_to() {
  ln -sfn "$1" "$APP_ROOT/current.next"
  mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
  pm2 startOrReload "$APP_ROOT/current/ecosystem.config.cjs" --update-env
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

log "Switching to $RELEASE"
switch_to "$DIR"
if ! healthy; then
  if [[ -n "$PREVIOUS" ]]; then
    log "Release $RELEASE is not healthy; rolling back to $(basename "$PREVIOUS")"
    switch_to "$PREVIOUS"
    healthy || log "Previous release is not healthy either: check 'pm2 logs pharmacy-pos-api'"
  fi
  fail "Deploy of $RELEASE failed (see 'pm2 logs pharmacy-pos-api')."
fi
pm2 save >/dev/null

log "Removing old releases (keeping $KEEP_RELEASES)"
CURRENT="$(readlink -f "$APP_ROOT/current")"
ls -1dt "$APP_ROOT"/releases/*/ | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  old="${old%/}"
  [[ "$old" == "$CURRENT" || "$old" == "$PREVIOUS" ]] || rm -rf -- "$old"
done

log "Deployed $RELEASE ($SHA)"

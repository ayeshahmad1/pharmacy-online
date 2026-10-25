#!/usr/bin/env bash
# Dumps the Postgres database, verifies the dump, keeps it locally for
# BACKUP_RETENTION_DAYS and, if BACKUP_REMOTE is set, uploads an (optionally
# encrypted) copy with rclone to any storage rclone supports (S3, Backblaze B2,
# Google Drive, SFTP...). Remote copies older than BACKUP_REMOTE_RETENTION_DAYS
# are pruned.
#
# Usage: backup-db.sh [daily|pre-deploy|manual]     (default: daily)
#
# Runs as the app user (cron, deploy.sh). Settings: /opt/pharmacy-pos/shared/backup.env
# (see deploy/backup.env.example). Database credentials come from the API's env file.
set -Eeuo pipefail
umask 077

LABEL="${1:-daily}"
case "$LABEL" in
  daily | pre-deploy | manual) ;;
  *)
    echo "Usage: $0 [daily|pre-deploy|manual]" >&2
    exit 64
    ;;
esac

APP_ROOT="${APP_ROOT:-/opt/pharmacy-pos}"
BACKUP_CONFIG="${BACKUP_CONFIG:-$APP_ROOT/shared/backup.env}"
if [[ -f "$BACKUP_CONFIG" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$BACKUP_CONFIG"
  set +a
fi

API_ENV_FILE="${API_ENV_FILE:-$APP_ROOT/shared/api.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pharmacy-pos}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_PRE_DEPLOY_KEEP="${BACKUP_PRE_DEPLOY_KEEP:-10}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_REMOTE_RETENTION_DAYS="${BACKUP_REMOTE_RETENTION_DAYS:-90}"
BACKUP_GPG_PASSPHRASE_FILE="${BACKUP_GPG_PASSPHRASE_FILE:-}"
BACKUP_HEALTHCHECK_URL="${BACKUP_HEALTHCHECK_URL:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST_DIR="$BACKUP_DIR/$LABEL"
NAME="pharmacy_pos-$LABEL-$STAMP.dump"
TMP_DIR="$(mktemp -d)"

log() { echo "$(date -Is) [backup:$LABEL] $*"; }

ping_healthcheck() {
  # Dead-man's switch (e.g. healthchecks.io): it alerts when the daily ping stops.
  [[ -n "$BACKUP_HEALTHCHECK_URL" && "$LABEL" == daily ]] || return 0
  curl -fsS -m 10 --retry 3 "$BACKUP_HEALTHCHECK_URL$1" >/dev/null ||
    log "WARN: healthcheck ping failed"
}

cleanup() { rm -rf "$TMP_DIR"; }
on_error() {
  log "FAILED (line $1)"
  ping_healthcheck /fail
}
trap cleanup EXIT
trap 'on_error $LINENO' ERR

mkdir -p "$DEST_DIR"
exec 9>"$BACKUP_DIR/.lock"
if ! flock -n 9; then
  log "Another backup is running; giving up"
  exit 75
fi

ping_healthcheck /start
log "Dumping database"
node "$SCRIPT_DIR/pg-env.mjs" "$API_ENV_FILE" pg_dump --format=custom --file="$TMP_DIR/$NAME"

# A dump pg_restore cannot read is no backup at all.
pg_restore --list "$TMP_DIR/$NAME" >/dev/null
(cd "$TMP_DIR" && sha256sum "$NAME" >"$NAME.sha256")
mv "$TMP_DIR/$NAME" "$TMP_DIR/$NAME.sha256" "$DEST_DIR/"
log "Saved $DEST_DIR/$NAME ($(du -h "$DEST_DIR/$NAME" | cut -f1))"

if [[ -n "$BACKUP_REMOTE" ]]; then
  UPLOAD="$DEST_DIR/$NAME"
  if [[ -n "$BACKUP_GPG_PASSPHRASE_FILE" ]]; then
    # Encrypt before the data leaves the server: the dump holds sales and staff records.
    gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" \
      --symmetric --cipher-algo AES256 \
      --output "$TMP_DIR/$NAME.gpg" "$DEST_DIR/$NAME"
    UPLOAD="$TMP_DIR/$NAME.gpg"
  fi
  log "Uploading to $BACKUP_REMOTE/$LABEL/"
  rclone copy --retries 5 "$UPLOAD" "$BACKUP_REMOTE/$LABEL/"
  rclone copy --retries 5 "$DEST_DIR/$NAME.sha256" "$BACKUP_REMOTE/$LABEL/"
  rclone delete --min-age "${BACKUP_REMOTE_RETENTION_DAYS}d" "$BACKUP_REMOTE/$LABEL/"
fi

# Local retention: daily/manual by age; pre-deploy dumps by count (deploys are irregular).
if [[ "$LABEL" == pre-deploy ]]; then
  ls -1t "$DEST_DIR"/*.dump | tail -n +"$((BACKUP_PRE_DEPLOY_KEEP + 1))" | while read -r old; do
    rm -f -- "$old" "$old.sha256"
  done
else
  find "$DEST_DIR" -maxdepth 1 -name 'pharmacy_pos-*.dump*' -mtime +"$BACKUP_RETENTION_DAYS" -delete
fi

ping_healthcheck ""
log "Done"

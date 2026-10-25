#!/usr/bin/env bash
# Restores a backup made by backup-db.sh into a NEW database, so the live one
# is never touched until you choose to swap. Run as root (sudo): it uses the
# postgres superuser through local peer authentication.
#
# Usage:
#   sudo restore-db.sh <backup.dump|backup.dump.gpg> <target-db>          restore and check only
#   sudo restore-db.sh <backup.dump|backup.dump.gpg> <target-db> --swap   then make it live
#
# --swap stops the API, renames the live database to <live>_before_restore_<stamp>
# (kept, so the swap can be undone) and the restored one to the live name, then
# starts the API again.
set -Eeuo pipefail
umask 077

usage() {
  sed -n '6,8p' "$0" >&2
  exit 64
}
[[ $# -eq 2 || ($# -eq 3 && "$3" == --swap) ]] || usage
if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 77
fi

FILE="$1"
TARGET="$2"
SWAP="${3:-}"
APP_ROOT="${APP_ROOT:-/opt/pharmacy-pos}"
APP_USER="${APP_USER:-pharmacy}"
API_ENV_FILE="${API_ENV_FILE:-$APP_ROOT/shared/api.env}"
BACKUP_CONFIG="${BACKUP_CONFIG:-$APP_ROOT/shared/backup.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_APP=pharmacy-pos-api

if [[ ! "$TARGET" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "Target database name may only use lowercase letters, digits and _." >&2
  exit 64
fi
if [[ ! -f "$FILE" ]]; then
  echo "No such file: $FILE" >&2
  exit 66
fi
if [[ -f "$BACKUP_CONFIG" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$BACKUP_CONFIG"
  set +a
fi

# The app's database role and live database name, from DATABASE_URL.
read -r DB_OWNER LIVE_DB < <(node "$SCRIPT_DIR/pg-env.mjs" "$API_ENV_FILE" \
  sh -c 'printf "%s %s\n" "$PGUSER" "$PGDATABASE"')
if [[ "$TARGET" == "$LIVE_DB" ]]; then
  echo "Target must not be the live database ($LIVE_DB): restore beside it, then --swap." >&2
  exit 64
fi

psql_admin() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -qAt "$@"; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

DUMP="$FILE"
if [[ "$FILE" == *.gpg ]]; then
  : "${BACKUP_GPG_PASSPHRASE_FILE:?Set BACKUP_GPG_PASSPHRASE_FILE in backup.env to decrypt}"
  DUMP="$TMP_DIR/$(basename "${FILE%.gpg}")"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" \
    --output "$DUMP" --decrypt "$FILE"
fi

# The .sha256 file sits next to the dump (download it too for a remote copy).
SUM_FILE="${FILE%.gpg}.sha256"
if [[ -f "$SUM_FILE" ]]; then
  expected="$(cut -d' ' -f1 "$SUM_FILE")"
  actual="$(sha256sum "$DUMP" | cut -d' ' -f1)"
  if [[ "$expected" != "$actual" ]]; then
    echo "Checksum mismatch for $FILE: the backup is damaged." >&2
    exit 65
  fi
  echo "Checksum OK."
else
  echo "No $SUM_FILE: skipping the checksum check."
fi

if [[ -n "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET'")" ]]; then
  echo "Database $TARGET already exists; pick another name or drop it first." >&2
  exit 73
fi

echo "Restoring $FILE into $TARGET (owner $DB_OWNER)..."
psql_admin -c "CREATE DATABASE \"$TARGET\" OWNER \"$DB_OWNER\""
runuser -u postgres -- pg_restore --exit-on-error --no-owner --role="$DB_OWNER" \
  --dbname="$TARGET" <"$DUMP"

echo "Restored. Check these against what you expect:"
runuser -u postgres -- psql -X -d "$TARGET" -c '
  SELECT (SELECT count(*) FROM "Sale") AS sales,
         (SELECT max("soldAt") FROM "Sale") AS last_sale,
         (SELECT count(*) FROM "Medicine") AS medicines,
         (SELECT count(*) FROM "StockMovement") AS stock_movements,
         (SELECT count(*) FROM "_prisma_migrations") AS migrations'

if [[ "$SWAP" != --swap ]]; then
  echo "The live database is untouched. Re-run with --swap to make $TARGET live, or drop it:"
  echo "  sudo -u postgres dropdb $TARGET"
  exit 0
fi

OLD="${LIVE_DB}_before_restore_$(date +%Y%m%d%H%M%S)"
echo "Swapping: $LIVE_DB -> $OLD, $TARGET -> $LIVE_DB"
sudo -u "$APP_USER" -H pm2 stop "$PM2_APP"
psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
               WHERE datname = '$LIVE_DB' AND pid <> pg_backend_pid()" >/dev/null
psql_admin -c "ALTER DATABASE \"$LIVE_DB\" RENAME TO \"$OLD\""
psql_admin -c "ALTER DATABASE \"$TARGET\" RENAME TO \"$LIVE_DB\""
sudo -u "$APP_USER" -H pm2 start "$PM2_APP"
echo "Done. The previous database is kept as $OLD; drop it once you are sure:"
echo "  sudo -u postgres dropdb $OLD"

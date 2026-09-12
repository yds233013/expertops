#!/usr/bin/env bash
#
# Back up the staging database, from the host, without publishing a database
# port. `pg_dump` runs inside the container and the dump comes out over stdout.
#
#   ./deploy/staging-backup.sh                 # into /var/backups/expertops
#   BACKUP_DIR=/tmp/x ./deploy/staging-backup.sh
#
# Exits non-zero on any failure so the systemd timer records it as failed and
# `systemctl list-timers` / the journal tell the operator.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-staging.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/expertops}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE next to this script." >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/expertops-staging-$stamp.dump"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

echo "Dumping $POSTGRES_DB to $target"
# -Fc is the custom format pg_restore needs to rebuild into a differently named
# database, which is what the restore check does.
compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$target"

# A dump that cannot be verified is not a backup. The sidecar is what the
# restore check reads before it creates anything.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$target" > "$target.sha256"
else
  shasum -a 256 "$target" > "$target.sha256"
fi

bytes="$(wc -c < "$target" | tr -d ' ')"
[ "$bytes" -gt 1024 ] || { echo "Dump is only $bytes bytes. Refusing to keep it." >&2; rm -f "$target" "$target.sha256"; exit 1; }
echo "Wrote $target ($bytes bytes)"

# Off-host copy. Without this, the backups die with the server they protect.
if [ -n "${RCLONE_REMOTE:-}" ]; then
  echo "Copying to $RCLONE_REMOTE"
  rclone copy "$target" "$RCLONE_REMOTE" --quiet
  rclone copy "$target.sha256" "$RCLONE_REMOTE" --quiet
else
  echo "RCLONE_REMOTE is not set: this backup exists only on this host." >&2
fi

find "$BACKUP_DIR" -name 'expertops-staging-*.dump*' -mtime "+$RETENTION_DAYS" -print -delete
echo "Retention: kept $RETENTION_DAYS days."

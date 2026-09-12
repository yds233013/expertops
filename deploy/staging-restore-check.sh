#!/usr/bin/env bash
#
# Restore a staging dump into a throwaway database and report what survived.
# Never touches the database the dump came from.
#
#   ./deploy/staging-restore-check.sh /var/backups/expertops/expertops-staging-….dump
#   ./deploy/staging-restore-check.sh …  --keep
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

dump="${1:?usage: staging-restore-check.sh <dump> [--keep]}"
keep="${2:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-staging.env}"

[ -f "$dump" ] || { echo "No such dump: $dump" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"

if [ -f "$dump.sha256" ]; then
  echo "Checking the sidecar before restoring anything"
  (cd "$(dirname "$dump")" && { command -v sha256sum >/dev/null 2>&1 \
      && sha256sum -c "$(basename "$dump").sha256" \
      || shasum -a 256 -c "$(basename "$dump").sha256"; })
else
  echo "No checksum sidecar next to the dump." >&2
fi

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
target="restorecheck_$(date -u +%Y%m%d%H%M%S)"

echo "Restoring into $target (a new, empty database)"
compose exec -T db createdb -U "$POSTGRES_USER" "$target"
# --no-owner: the dump's roles do not have to exist in the copy.
compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$target" --no-owner < "$dump"

echo
compose exec -T db psql -U "$POSTGRES_USER" -d "$target" -At -c '
  SELECT
    (SELECT count(*) FROM "User")          AS operators,
    (SELECT count(*) FROM "Expert")        AS experts,
    (SELECT count(*) FROM "Project")       AS projects,
    (SELECT count(*) FROM "ActivityEvent") AS activity,
    (SELECT count(*) FROM "Job")           AS jobs,
    (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL) AS migrations;'
echo

if [ "$keep" = "--keep" ]; then
  echo "Kept $target. Drop it with: docker compose exec db dropdb -U $POSTGRES_USER $target"
else
  compose exec -T db dropdb -U "$POSTGRES_USER" "$target"
  echo "Dropped $target. The source database was never touched."
fi

#!/usr/bin/env bash
#
# Restore a backup into a throwaway database and check what survived.
#
# This never touches the database the backup came from. It creates a uniquely
# named target, restores into it, counts what matters, and drops it again
# unless asked to keep it.
#
#   ./scripts/restore-check.sh backups/expertops-20260912T010203Z.dump
#   ./scripts/restore-check.sh backup.dump --keep
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

# Load .env for values that are NOT already set.
#
# `set -a; . ./.env` would do the opposite: it overwrites the environment, so a
# caller who deliberately points the script at another database gets the
# development one instead. That is the wrong direction for a tool that reads
# and writes whole databases, and it was caught by a test that asked for the
# test database and was handed development.
load_env_defaults() {
  [ -f .env ] || return 0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue;; esac
    case "$line" in *=*) ;; *) continue;; esac
    local key="${line%%=*}"
    local value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    # Strip surrounding quotes, which `.env` files normally carry.
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    if [ -z "${!key:-}" ]; then export "$key=$value"; fi
  done < .env
}
load_env_defaults
: "${DATABASE_URL:?DATABASE_URL is not set.}"

# Prisma's connection URL carries `?schema=`, which libpq rejects. The Postgres
# tools want the same URL without it.
libpq_url() {
  node -e '
    const u = new URL(process.argv[1]);
    for (const key of ["schema", "connection_limit", "pool_timeout", "connect_timeout", "pgbouncer", "socket_timeout"]) {
      u.searchParams.delete(key);
    }
    if ([...u.searchParams].length === 0) u.search = "";
    console.log(u.toString());
  ' "$1"
}

# The dump format is version-sensitive: a pg_dump older than the server refuses
# to run at all. Rather than making that the operator's problem, use the client
# tools inside the database container when the ones on PATH do not match.
#
#   EXPERTOPS_PG_CONTAINER=<name>  force a container (default: expertops-db)
#   EXPERTOPS_PG_LOCAL=1           force the tools on PATH
PG_CONTAINER="${EXPERTOPS_PG_CONTAINER:-expertops-db}"

server_major() {
  psql "$1" -tAc 'SHOW server_version_num;' 2>/dev/null | cut -c1-2
}

pick_pg_tools() {
  local url="$1"
  if [ "${EXPERTOPS_PG_LOCAL:-}" = "1" ]; then PG_MODE=local; return; fi
  local client server
  client="$(pg_dump --version 2>/dev/null | sed -E 's/.* ([0-9]+).*/\1/')"
  server="$(server_major "$url")"
  if [ -n "$client" ] && [ -n "$server" ] && [ "$client" = "$server" ]; then
    PG_MODE=local
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
    PG_MODE=container
    echo "Using the client tools inside container ${PG_CONTAINER} (PATH pg_dump is ${client:-unknown}, server is ${server:-unknown})"
  else
    PG_MODE=local
    echo "Warning: pg_dump ${client:-unknown} against server ${server:-unknown}. Install matching client tools if this fails." >&2
  fi
}

# Inside the container the server is on its own port, not the published one.
container_url() {
  node -e '
    const u = new URL(process.argv[1]);
    u.hostname = "localhost";
    u.port = "5432";
    console.log(u.toString());
  ' "$1"
}

dump="${1:?usage: restore-check.sh <dump-file> [--keep]}"
keep="${2:-}"
[ -f "$dump" ] || { echo "No such backup: $dump" >&2; exit 1; }

if [ -f "${dump}.sha256" ]; then
  echo "Checking the backup is intact"
  ( cd "$(dirname "$dump")" && shasum -a 256 -c "$(basename "${dump}.sha256")" )
fi

PG_URL="$(libpq_url "$DATABASE_URL")"
pick_pg_tools "$PG_URL"

target="expertops_restore_$(date -u '+%Y%m%d%H%M%S')_$$"
admin_url="$(node -e '
  const u = new URL(process.argv[1]);
  u.pathname = "/postgres";
  u.search = "";
  console.log(u.toString());
' "$PG_URL")"
target_url="$(node -e '
  const u = new URL(process.argv[1]);
  u.pathname = "/" + process.argv[2];
  u.search = "";
  console.log(u.toString());
' "$PG_URL" "$target")"

# Every psql/pg_restore call goes through these, so the container fallback is
# applied uniformly.
run_psql() {
  if [ "$PG_MODE" = "container" ]; then
    docker exec -i "$PG_CONTAINER" psql "$(container_url "$1")" "${@:2}"
  else
    psql "$1" "${@:2}"
  fi
}

cleanup() {
  if [ "$keep" != "--keep" ]; then
    run_psql "$admin_url" -q -c "DROP DATABASE IF EXISTS \"$target\";" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Restoring into a disposable database: $target"
run_psql "$admin_url" -q -c "CREATE DATABASE \"$target\";"
if [ "$PG_MODE" = "container" ]; then
  docker exec -i "$PG_CONTAINER" pg_restore --no-owner --no-privileges \
    --dbname="$(container_url "$target_url")" < "$dump"
else
  pg_restore --no-owner --no-privileges --dbname="$target_url" "$dump"
fi

echo
echo "What survived the restore:"
run_psql "$target_url" -q -t -A -F' | ' <<'SQL'
SELECT 'experts', count(*) FROM "Expert"
UNION ALL SELECT 'projects', count(*) FROM "Project"
UNION ALL SELECT 'candidates', count(*) FROM "Candidate"
UNION ALL SELECT 'screenings', count(*) FROM "Screening"
UNION ALL SELECT 'assignments', count(*) FROM "Assignment"
UNION ALL SELECT 'work items', count(*) FROM "WorkItem"
UNION ALL SELECT 'payment items', count(*) FROM "PaymentItem"
UNION ALL SELECT 'audit history', count(*) FROM "ActivityEvent"
UNION ALL SELECT 'outbox messages', count(*) FROM "OutboxMessage"
UNION ALL SELECT 'queued jobs', count(*) FROM "Job" WHERE status IN ('PENDING','FAILED','RUNNING')
UNION ALL SELECT 'job history', count(*) FROM "Job"
UNION ALL SELECT 'schedules', count(*) FROM "Schedule"
UNION ALL SELECT 'applied migrations', count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
SQL

echo
if [ "$keep" = "--keep" ]; then
  echo "Kept as $target. Drop it yourself when you are done:"
  echo "  psql \"\$ADMIN_URL\" -c 'DROP DATABASE \"$target\";'"
else
  echo "Disposable database dropped. The source database was never touched."
fi

#!/usr/bin/env bash
#
# Take a backup of the ExpertOps database.
#
# A plain `pg_dump` in custom format, which is what `pg_restore` needs to rebuild
# into a differently-named database. Nothing clever: the point of a backup
# procedure is that it works when somebody tired is running it at the wrong
# hour, so it is one command with no options to get wrong.
#
#   ./scripts/backup.sh                    # backs up $DATABASE_URL
#   ./scripts/backup.sh backups/before-migration
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
: "${DATABASE_URL:?DATABASE_URL is not set. Copy .env.example to .env first.}"

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

PG_URL="$(libpq_url "$DATABASE_URL")"
pick_pg_tools "$PG_URL"


prefix="${1:-backups/expertops}"
mkdir -p "$(dirname "$prefix")"
stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
out="${prefix}-${stamp}.dump"

# Read the target out of the URL so the log line says what was backed up
# without echoing the password.
db="$(node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.pathname.slice(1))')"
host="$(node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.host)')"

echo "Backing up ${db} at ${host}"
if [ "$PG_MODE" = "container" ]; then
  docker exec -i "$PG_CONTAINER" pg_dump --format=custom --no-owner --no-privileges \
    "$(container_url "$PG_URL")" > "$out"
else
  pg_dump --format=custom --no-owner --no-privileges --file="$out" "$PG_URL"
fi

bytes="$(wc -c < "$out" | tr -d ' ')"
sha="$(shasum -a 256 "$out" | awk '{print $1}')"
printf '%s  %s\n' "$sha" "$(basename "$out")" > "${out}.sha256"

echo "Wrote ${out} (${bytes} bytes)"
echo "SHA-256 ${sha}"
echo
echo "A backup nobody has restored is a hypothesis. Verify it with:"
echo "  ./scripts/restore-check.sh ${out}"

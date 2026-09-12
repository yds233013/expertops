#!/usr/bin/env bash
#
# One command an operator (or cron, or an uptime monitor's "run a script"
# hook) can use to answer: is staging actually working?
#
# Checks three things, because they fail independently:
#   1. the app answers /api/health through the public gate
#   2. every container that should be running is running
#   3. the worker wrote a heartbeat recently — a worker can be "up" and stuck
#
#   ./deploy/staging-healthcheck.sh
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-staging.env}"
# A worker tick is seconds; five minutes of silence is a problem, not a blip.
HEARTBEAT_MAX_AGE_SECONDS="${HEARTBEAT_MAX_AGE_SECONDS:-300}"

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a
compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

failures=0
note() { printf '  %-8s %s\n' "$1" "$2"; }

# 1. HTTP, through the gate the testers use. TESTER_PASSWORD is the plaintext
# behind TESTER_PASSWORD_HASH; keep it in the operator's password manager, not
# in staging.env.
url="${HEALTH_URL:-${APP_BASE_URL:-}/api/health}"
auth=()
if [ -n "${TESTER_USERNAME:-}" ] && [ -n "${TESTER_PASSWORD:-}" ]; then
  auth=(--user "$TESTER_USERNAME:$TESTER_PASSWORD")
fi
# ${auth[@]+…} so an empty array does not trip `set -u` on bash 3.
if body="$(curl -fsS --max-time 10 ${auth[@]+"${auth[@]}"} "$url" 2>&1)"; then
  note "ok" "app answered: $body"
else
  note "FAIL" "app did not answer $url: $body"; failures=$((failures + 1))
fi

# 2. Containers. SERVICES is overridable because the local rehearsal runs the
# same stack without caddy.
for service in ${SERVICES:-db app worker caddy}; do
  state="$(compose ps --format '{{.State}}' "$service" 2>/dev/null | head -1)"
  if [ "$state" = "running" ]; then
    note "ok" "$service is running"
  else
    note "FAIL" "$service is ${state:-absent}"; failures=$((failures + 1))
  fi
done

# 3. Worker heartbeat freshness, read straight from the database.
age="$(compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c \
  'SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max("lastSeenAt")))::int, 999999) FROM "WorkerHeartbeat";' 2>/dev/null || echo 999999)"
if [ "$age" -le "$HEARTBEAT_MAX_AGE_SECONDS" ]; then
  note "ok" "worker heartbeat ${age}s old"
else
  note "FAIL" "worker heartbeat ${age}s old (limit ${HEARTBEAT_MAX_AGE_SECONDS}s)"; failures=$((failures + 1))
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "staging: healthy"
else
  echo "staging: $failures check(s) failed" >&2
  exit 1
fi

#!/usr/bin/env bash
# Project Memory PostgreSQL integration tests against a throwaway database.
#
# Starts a disposable postgres:16-alpine container (tmpfs, bound to 127.0.0.1, removed on
# exit), applies the real Prisma migrations, runs test/integration, and tears down.
# It never touches the development database.
set -euo pipefail

cd "$(dirname "$0")/../.."

NAME="projectx-memory-it-$$"
PORT="${MEMORY_IT_PORT:-55432}"
DB="projectx_memory_it"
URL="postgresql://postgres:it@127.0.0.1:${PORT}/${DB}"

docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=it -e POSTGRES_DB="$DB" \
  -p "127.0.0.1:${PORT}:5432" \
  --tmpfs /var/lib/postgresql/data \
  postgres:16-alpine >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null

DATABASE_URL="$URL" npx prisma migrate deploy
MEMORY_IT_DATABASE_URL="$URL" npx vitest run test/integration "$@"

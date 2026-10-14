#!/usr/bin/env bash
# Runs on the Docker host: build, start, and wait for the health check.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env (copy .env.example and fill it in)" >&2; exit 1; }
[ -f secrets/oidc_client_secret ] || { echo "Missing secrets/oidc_client_secret" >&2; exit 1; }
mkdir -p data

docker compose build -q
docker compose up -d
port=$(grep -E '^ALMANAC_PORT=' .env | cut -d= -f2 || true)
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port:-18085}/healthz" >/dev/null 2>&1; then
    echo "healthy"
    exit 0
  fi
  sleep 1
done
echo "not healthy after 30 s" >&2
docker compose logs --tail=40 almanac >&2
exit 1

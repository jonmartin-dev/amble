#!/usr/bin/env bash
# Runs on the Docker host: build, start, and wait for the health check.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env (copy .env.example and fill it in)" >&2; exit 1; }
# A sign-in provider's secret is optional: without one, people get in with codes.
mkdir -p data

docker compose build -q
docker compose up -d
# ALMANAC_PORT is the name from before the app was renamed.
port=$(grep -E '^(AMBLE|ALMANAC)_PORT=' .env | head -1 | cut -d= -f2 || true)
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port:-18085}/healthz" >/dev/null 2>&1; then
    echo "healthy"
    exit 0
  fi
  sleep 1
done
echo "not healthy after 30 s" >&2
docker compose logs --tail=40 amble >&2
exit 1

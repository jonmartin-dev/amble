#!/usr/bin/env bash
# Ship the working tree to a Docker host over SSH and rebuild there.
# The target directory keeps its own .env, data/ and secrets/; they are never overwritten.
# Usage: deploy/ssh-deploy.sh [host] [dir]    (defaults: docker-host /opt/almanac)
set -euo pipefail
host=${1:-docker-host}
dir=${2:-/opt/almanac}
cd "$(dirname "$0")/.."

git ls-files --cached --others --exclude-standard -z \
  | grep -zv -e '^design/' -e '^\.claude/' \
  | tar --null -T - -czf - \
  | ssh -o ConnectTimeout=10 "$host" "mkdir -p '$dir' && tar -xzf - -C '$dir' && bash '$dir/deploy/server-up.sh'"

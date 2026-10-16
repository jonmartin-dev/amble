#!/usr/bin/env bash
# Ship the working tree to a Docker host over SSH and rebuild there.
# The target directory keeps its own .env, data/ and secrets/; they are never overwritten.
# Usage: deploy/ssh-deploy.sh [host] [dir]
#   host and dir default to AMBLE_DEPLOY_HOST and AMBLE_DEPLOY_DIR, which deploy/local.env
#   (ignored by git) can set for your own server. dir falls back to /opt/amble.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/local.env ] && . deploy/local.env
# ALMANAC_DEPLOY_* are the names from before the app was renamed.
AMBLE_DEPLOY_HOST=${AMBLE_DEPLOY_HOST:-${ALMANAC_DEPLOY_HOST:-}}
AMBLE_DEPLOY_DIR=${AMBLE_DEPLOY_DIR:-${ALMANAC_DEPLOY_DIR:-}}
host=${1:-${AMBLE_DEPLOY_HOST:?Give the SSH host as the first argument or set AMBLE_DEPLOY_HOST}}
dir=${2:-${AMBLE_DEPLOY_DIR:-/opt/amble}}

git ls-files --cached --others --exclude-standard -z \
  | grep -zv -e '^design/' -e '^\.claude/' -e '^deploy/local\.env$' \
  | tar --null -T - -czf - \
  | ssh -o ConnectTimeout=10 "$host" "mkdir -p '$dir' && tar -xzf - -C '$dir' && bash '$dir/deploy/server-up.sh'"

#!/usr/bin/env bash
# Ship the working tree to a Docker host over SSH and rebuild there.
# The target directory keeps its own .env, data/ and secrets/; they are never overwritten.
# Usage: deploy/ssh-deploy.sh [host] [dir]
#   host and dir default to ALMANAC_DEPLOY_HOST and ALMANAC_DEPLOY_DIR, which deploy/local.env
#   (ignored by git) can set for your own server. dir falls back to /opt/almanac.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/local.env ] && . deploy/local.env
host=${1:-${ALMANAC_DEPLOY_HOST:?Give the SSH host as the first argument or set ALMANAC_DEPLOY_HOST}}
dir=${2:-${ALMANAC_DEPLOY_DIR:-/opt/almanac}}

git ls-files --cached --others --exclude-standard -z \
  | grep -zv -e '^design/' -e '^\.claude/' -e '^deploy/local\.env$' \
  | tar --null -T - -czf - \
  | ssh -o ConnectTimeout=10 "$host" "mkdir -p '$dir' && tar -xzf - -C '$dir' && bash '$dir/deploy/server-up.sh'"

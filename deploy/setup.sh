#!/usr/bin/env bash
# Sets up an Amble server with Docker on this computer, or checks one. It asks for what it needs
# (or takes it from flags, so an AI assistant can run it without questions), writes .env and
# secrets/, builds and starts the container, and checks each part. docs/self-hosting.md walks
# through it.
#
#   deploy/setup.sh            set up, asking for anything not given (run again, it keeps what's set)
#   deploy/setup.sh --check    check a setup and say what to fix; exits 1 if anything needs fixing
#   deploy/setup.sh --update   back up the database, get the latest code (in a git clone), rebuild
#
# Flags, for setting up without questions (with --yes, anything missing is an error instead):
#   --url https://amble.example.com    the address people use, with its path if it has one
#   --admin you@example.com            admins, comma-separated
#   --allow partner@example.com        others who may sign in, comma-separated
#   --client-id ID                     the sign-in client's ID
#   --client-secret-file PATH          a file holding the sign-in client's secret
#   --issuer URL --provider-name NAME  another OpenID Connect provider (Google by default)
#   --timezone Area/City               the household's time zone (this computer's by default)
#   --port 18085                       the port on this computer the server listens on
#   --ai-provider NAME --ai-key-file PATH   optional: or set the AI model later in the app
#   --privacy-contact EMAIL            optional: shown on the app's /privacy page
set -euo pipefail
cd "$(dirname "$0")/.."

mode=setup yes=0 problems=0 reachable=0
url='' admin='' allow='' client_id='' secret_file='' issuer='' provider='' tz='' port='' ai_provider='' ai_key_file='' privacy=''
value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    echo "$1 needs a value (see --help)" >&2
    exit 2
  fi
  printf '%s' "$2"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check ;;
    --update) mode=update ;;
    --yes) yes=1 ;;
    --url) url=$(value "$@"); shift ;;
    --admin) admin=$(value "$@"); shift ;;
    --allow) allow=$(value "$@"); shift ;;
    --client-id) client_id=$(value "$@"); shift ;;
    --client-secret-file) secret_file=$(value "$@"); shift ;;
    --issuer) issuer=$(value "$@"); shift ;;
    --provider-name) provider=$(value "$@"); shift ;;
    --timezone) tz=$(value "$@"); shift ;;
    --port) port=$(value "$@"); shift ;;
    --ai-provider) ai_provider=$(value "$@"); shift ;;
    --ai-key-file) ai_key_file=$(value "$@"); shift ;;
    --privacy-contact) privacy=$(value "$@"); shift ;;
    -h | --help)
      sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

ok() { printf '[ok]   %s\n' "$*"; }
note() { printf '[note] %s\n' "$*"; }
bad() {
  printf '[fix]  %s\n' "$*"
  problems=$((problems + 1))
}
die() {
  printf '[fix]  %s\n' "$*" >&2
  exit 1
}

# A setting from .env, or from its ALMANAC_ name from before the app was renamed.
env_get() {
  [ -f .env ] || return 0
  local v
  v=$(grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true)
  if [ -z "$v" ] && [ "${1#AMBLE_}" != "$1" ]; then v=$(grep -E "^ALMANAC_${1#AMBLE_}=" .env | tail -1 | cut -d= -f2- || true); fi
  v=${v%$'\r'}
  v=${v%\"}
  v=${v#\"}
  printf '%s' "$v"
}

# ask VAR "Question" default: asks on a terminal; with --yes, or with no one to ask, takes the default.
ask() {
  local answer
  if [ "$yes" = 1 ] || [ ! -t 0 ]; then
    printf -v "$1" '%s' "${3-}"
    return
  fi
  if [ -n "${3-}" ]; then read -r -p "$2 [$3]: " answer; else read -r -p "$2: " answer; fi
  printf -v "$1" '%s' "${answer:-${3-}}"
}

host_timezone() {
  local z=
  if command -v timedatectl >/dev/null 2>&1; then z=$(timedatectl show -p Timezone --value 2>/dev/null || true); fi
  if [ -z "$z" ] && [ -f /etc/timezone ]; then z=$(head -1 /etc/timezone); fi
  if [ -z "$z" ] && [ -L /etc/localtime ]; then z=$(readlink /etc/localtime | sed 's#.*zoneinfo/##'); fi
  if [ -z "$z" ] && command -v node >/dev/null 2>&1; then z=$(node -e 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)' 2>/dev/null || true); fi
  printf '%s' "$z"
}

# Docker Desktop (Mac, Windows) shares folders with containers whoever owns them; Docker on Linux
# needs data/ and secrets/ to belong to the container's user, uid 1000.
docker_desktop() {
  case "$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)" in *'Docker Desktop'*) return 0 ;; *) return 1 ;; esac
}
owner_of() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1"; }
owned_by_container() {
  local f
  for f in data secrets secrets/*; do
    [ -e "$f" ] || continue
    [ "$(owner_of "$f")" = 1000 ] || return 1
  done
}

docker_ready() {
  if ! command -v docker >/dev/null 2>&1; then
    bad "Docker isn't installed: Docker Engine on Linux, Docker Desktop on a Mac or Windows (https://docs.docker.com/get-docker/)."
  elif ! docker compose version >/dev/null 2>&1; then
    bad "Docker Compose v2 is missing (the 'docker compose' command): it comes with Docker Desktop, or install the docker-compose-plugin package."
  elif ! docker info >/dev/null 2>&1; then
    bad "Docker isn't running, or this user can't use it: start Docker, or add yourself to the docker group (sudo usermod -aG docker \$USER, then sign in again)."
  else
    ok "Docker is running"
    return 0
  fi
  return 1
}

local_health() { curl -fsS --max-time 5 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; }
wait_healthy() {
  local _
  for _ in $(seq 1 60); do
    local_health "$1" && return 0
    sleep 1
  done
  return 1
}

check() {
  problems=0
  docker_ready || true
  if [ ! -f .env ]; then
    bad "There's no .env here yet: run deploy/setup.sh to make one."
    return
  fi
  local u i name id p admins
  u=$(env_get AMBLE_PUBLIC_URL)
  i=$(env_get OIDC_ISSUER)
  i=${i:-https://accounts.google.com}
  name=$(env_get OIDC_PROVIDER_NAME)
  name=${name:-Google}
  id=$(env_get OIDC_CLIENT_ID)
  p=$(env_get AMBLE_PORT)
  p=${p:-18085}
  admins=$(env_get AMBLE_ADMIN_EMAILS)

  case "$u" in
    https://* | http://*) ok "Address: $u" ;;
    '') bad "AMBLE_PUBLIC_URL isn't set in .env: the address people use, like https://amble.example.com." ;;
    *) bad "AMBLE_PUBLIC_URL ($u) has to start with https:// (or http://)." ;;
  esac
  case "$u" in
    http://*) note "The address isn't HTTPS. The Android app is fine with that at home or over Tailscale, but browsers, Google sign-in, and Claude and ChatGPT need HTTPS." ;;
  esac
  if [ -n "$admins" ]; then ok "Admins: $admins"; else bad "AMBLE_ADMIN_EMAILS isn't set in .env: your own email, so you can sign in."; fi
  if [ -n "$id" ]; then ok "Sign-in client: $id"; else bad "OIDC_CLIENT_ID isn't set in .env: the client ID from your sign-in provider (docs/self-hosting.md, step 3)."; fi
  if [ -s secrets/oidc_client_secret ]; then ok "The sign-in client's secret is in secrets/oidc_client_secret"; else bad "secrets/oidc_client_secret is missing or empty: put the sign-in client's secret in it."; fi
  if [ ! -d data ]; then
    bad "There's no data/ folder: run deploy/setup.sh."
  elif ! docker_desktop && ! owned_by_container; then
    bad "data/ and secrets/ have to belong to the container's user (uid 1000): sudo chown -R 1000:1000 data secrets"
  fi

  if local_health "$p"; then
    ok "The server is running on 127.0.0.1:$p"
  else
    bad "Nothing answers on 127.0.0.1:$p: start it with deploy/setup.sh, and read docker compose logs amble if it won't start."
  fi

  reachable=0
  if [ -n "$u" ] && curl -fsS --max-time 10 "$u/healthz" >/dev/null 2>&1; then
    reachable=1
    ok "Reachable at $u (from this computer)"
  elif [ -n "$u" ]; then
    bad "Not reachable at $u yet: point your reverse proxy or Tailscale at 127.0.0.1:$p (docs/self-hosting.md, step 5)."
  fi

  local discovery reported
  if discovery=$(curl -fsS --max-time 10 "${i%/}/.well-known/openid-configuration" 2>/dev/null); then
    reported=$(printf '%s' "$discovery" | tr -d '\n' | sed -n 's/.*"issuer"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ "$reported" = "$i" ]; then ok "Sign-in provider: $name ($i)"; else bad "OIDC_ISSUER is $i, but the provider calls itself $reported: copy that exactly, trailing slash and all."; fi
  else
    bad "Couldn't read the sign-in provider's settings at $i/.well-known/openid-configuration: check OIDC_ISSUER."
  fi

  # Google answers a sign-in for an address it doesn't know right away, so ask it.
  if [ "$reachable" = 1 ] && [ "$i" = https://accounts.google.com ]; then
    local start page
    start=$(curl -sS -o /dev/null --max-time 10 -w '%{redirect_url}' "$u/auth/login?direct=1" 2>/dev/null || true)
    case "$start" in
      https://accounts.google.com/*)
        # The page Google ends on, then the address it ended at on the last line.
        page=$(curl -sSL --max-time 10 -w '\n%{url_effective}' "$start" 2>/dev/null || true)
        # Here-strings, not pipes: grep -q stops at a match, and pipefail would count that as failing.
        if grep -q 'redirect_uri_mismatch' <<<"$page"; then
          bad "Google doesn't have $u/auth/callback as a redirect URI on this client: add it under Authorized redirect URIs."
        elif grep -qE 'invalid_client|deleted_client|OAuth client was not found' <<<"$page"; then
          bad "Google doesn't know the client ID $id: copy it again from Google Cloud, Clients."
        elif grep -q '/signin/oauth/error' <<<"${page##*$'\n'}"; then
          bad "Google turned down a sign-in for $u: try signing in at $u/server to see why."
        else
          ok "Google accepts sign-ins for $u"
        fi
        ;;
      *) note "Couldn't start a sign-in at $u/auth/login to test it; try signing in at $u/server." ;;
    esac
  elif [ "$reachable" = 1 ]; then
    note "The sign-in client has to list this redirect URI: $u/auth/callback"
  fi

  if [ -s secrets/ai_api_key ] || [ -s secrets/anthropic_api_key ]; then
    ok "An AI key is in secrets/"
  else
    note "No AI key in secrets/: an admin can set the household's model in the app (Settings, AI), or leave AI off."
  fi

  if [ "$problems" = 0 ]; then echo "Everything checked out."; else echo "$problems thing(s) to fix."; fi
}

if [ "$mode" = check ]; then
  check
  [ "$problems" = 0 ]
  exit
fi

command -v curl >/dev/null 2>&1 || die "curl is missing: install it (it checks the server once it's up)."
docker_ready || exit 1

if [ "$mode" = update ]; then
  [ -f .env ] || die "There's no .env here yet: run deploy/setup.sh first."
  port=$(env_get AMBLE_PORT)
  port=${port:-18085}
  if local_health "$port"; then
    docker compose exec -T amble node server/backup.ts && ok "Backed up the database to data/snapshots/almanac-latest.db"
  fi
  if [ -d .git ]; then git pull --ff-only; else note "This isn't a git clone, so it rebuilds the code that's here."; fi
  docker compose up -d --build
  wait_healthy "$port" || {
    docker compose logs --tail=40 amble >&2
    die "The server didn't come up within a minute; the log is above."
  }
  ok "Updated and running"
  check
  [ "$problems" = 0 ]
  exit
fi

# Setting up: flags first, then what .env already has, then questions.
echo "Setting up an Amble server in $(pwd)."
echo "docs/self-hosting.md explains each answer. Press Enter to keep what's in [brackets]."
echo
ask url "The address people will use (https://...)" "${url:-$(env_get AMBLE_PUBLIC_URL)}"
url=${url%/}
case "$url" in
  https://* | http://*) ;;
  '') die "The address is needed (--url): https://amble.example.com, or a Tailscale name like https://server.tail1234.ts.net" ;;
  *) die "The address has to start with https:// (or http://): $url" ;;
esac
ask admin "Your email, to sign in as the admin (more, comma-separated)" "${admin:-$(env_get AMBLE_ADMIN_EMAILS)}"
case "$admin" in *@*) ;; *) die "An admin email is needed (--admin)." ;; esac
ask allow "Others in the household who may sign in (comma-separated, or none)" "${allow:-$(env_get AMBLE_ALLOWED_EMAILS)}"
[ "$allow" = none ] && allow=
tz=${tz:-$(env_get AMBLE_TIMEZONE)}
tz=${tz:-$(host_timezone)}
ask tz "The household's time zone, like America/Chicago or Europe/Berlin" "$tz"
[ -n "$tz" ] || die "A time zone is needed (--timezone), like America/Chicago."
issuer=${issuer:-$(env_get OIDC_ISSUER)}
# Kept exactly as given: it has to match what the provider calls itself, trailing slash and all.
ask issuer "The sign-in provider's issuer (Enter for Google)" "${issuer:-https://accounts.google.com}"
provider=${provider:-$(env_get OIDC_PROVIDER_NAME)}
if [ "$issuer" = https://accounts.google.com ]; then provider=${provider:-Google}; fi
ask provider "The sign-in provider's name, for its button (\"Continue with ...\")" "$provider"
[ -n "$provider" ] || die "A name for the sign-in provider is needed (--provider-name), like Authelia."
ask client_id "The sign-in client's ID" "${client_id:-$(env_get OIDC_CLIENT_ID)}"
[ -n "$client_id" ] || die "The sign-in client's ID is needed (--client-id): docs/self-hosting.md, step 3."
port=${port:-$(env_get AMBLE_PORT)}
port=${port:-18085}
privacy=${privacy:-$(env_get AMBLE_PRIVACY_CONTACT)}
ai_provider=${ai_provider:-$(env_get AMBLE_AI_PROVIDER)}

secret=
if [ -n "$secret_file" ]; then
  [ -s "$secret_file" ] || die "$secret_file is missing or empty."
  secret=$(tr -d '\r\n' <"$secret_file")
elif [ ! -s secrets/oidc_client_secret ]; then
  if [ "$yes" = 1 ] || [ ! -t 0 ]; then die "The sign-in client's secret is needed (--client-secret-file)."; fi
  read -r -s -p "The sign-in client's secret (it won't show): " secret
  echo
  [ -n "$secret" ] || die "The sign-in client's secret is needed."
fi
ai_key=
if [ -n "$ai_key_file" ]; then
  [ -s "$ai_key_file" ] || die "$ai_key_file is missing or empty."
  [ -n "$ai_provider" ] || die "Say which AI provider the key is for (--ai-provider anthropic, openai, gemini, zai, openrouter)."
  ai_key=$(tr -d '\r\n' <"$ai_key_file")
fi

# .env: these settings, plus anything else an earlier one set.
managed=' AMBLE_PUBLIC_URL AMBLE_TIMEZONE AMBLE_PORT AMBLE_ADMIN_EMAILS AMBLE_ALLOWED_EMAILS OIDC_ISSUER OIDC_PROVIDER_NAME OIDC_CLIENT_ID AMBLE_PRIVACY_CONTACT AMBLE_AI_PROVIDER '
kept=
if [ -f .env ]; then
  backup=".env.backup-$(date +%Y%m%d-%H%M%S)"
  cp .env "$backup"
  note "Kept a copy of the old .env as $backup"
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    key=${line%%=*}
    case "$key" in ALMANAC_*) key="AMBLE_${key#ALMANAC_}" ;; esac
    case "$managed" in *" $key "*) ;; *) kept="$kept$line"$'\n' ;; esac
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env || true)
fi
{
  echo "# Written by deploy/setup.sh. Run it again to change these; it keeps anything else set below."
  echo "# .env.example explains every setting."
  echo "AMBLE_PUBLIC_URL=$url"
  echo "AMBLE_TIMEZONE=$tz"
  echo "AMBLE_PORT=$port"
  echo "AMBLE_ADMIN_EMAILS=$admin"
  echo "AMBLE_ALLOWED_EMAILS=$allow"
  echo "OIDC_ISSUER=$issuer"
  echo "OIDC_PROVIDER_NAME=$provider"
  echo "OIDC_CLIENT_ID=$client_id"
  if [ -n "$privacy" ]; then echo "AMBLE_PRIVACY_CONTACT=$privacy"; fi
  if [ -n "$ai_provider" ]; then echo "AMBLE_AI_PROVIDER=$ai_provider"; fi
  if [ -n "$kept" ]; then
    echo
    echo "# From the earlier .env"
    printf '%s' "$kept"
  fi
} >.env.new
mv .env.new .env
ok "Wrote .env"

mkdir -p data secrets
chmod 700 secrets 2>/dev/null || true
put_secret() {
  (umask 077 && printf '%s' "$2" >"secrets/$1") 2>/dev/null || die "Couldn't write secrets/$1: run this as the folder's owner, or with sudo."
}
if [ -n "$secret" ]; then put_secret oidc_client_secret "$secret"; fi
if [ -n "$ai_key" ]; then put_secret ai_api_key "$ai_key"; fi
ok "Secrets are in secrets/, readable only by their owner"
if ! docker_desktop && ! owned_by_container; then
  if [ "$(id -u)" = 0 ]; then
    chown -R 1000:1000 data secrets
  else
    note "The container runs as uid 1000, so data/ and secrets/ have to belong to it: sudo chown -R 1000:1000 data secrets"
    sudo chown -R 1000:1000 data secrets || die "Couldn't hand data/ and secrets/ to uid 1000; run that sudo line yourself, then this script again."
  fi
  ok "data/ and secrets/ belong to the container's user"
fi

echo
echo "Building and starting the server (the first build takes a few minutes)..."
docker compose up -d --build
wait_healthy "$port" || {
  docker compose logs --tail=40 amble >&2
  die "The server didn't come up within a minute; the log is above."
}
ok "The server is running on 127.0.0.1:$port"
echo
check
echo
echo "Next:"
if [ "$reachable" = 0 ]; then
  echo "  - Make $url reach port $port on this computer (docs/self-hosting.md, step 5)."
  echo "  - The sign-in client's redirect URI has to be exactly: $url/auth/callback"
fi
if [ "$problems" != 0 ]; then
  echo "  - Fix what's marked [fix] above, and run deploy/setup.sh --check until it passes."
fi
echo "  - Open $url/server and sign in as ${admin%%,*}."
echo "  - Add phones with the code in Settings, Your server (docs/self-hosting.md, step 7)."

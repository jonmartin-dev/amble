#!/usr/bin/env bash
# Sets up an Amble server with Docker on this computer, or checks one. It asks for what it needs
# (or takes it from flags, so an AI assistant can run it without questions), writes .env and
# secrets/, builds and starts the container, points Tailscale at it, checks each part, and shows
# the code that lets the first phone in as the admin. docs/self-hosting.md walks through it.
#
#   deploy/setup.sh               set up, asking for anything not given (run again, it keeps what's set)
#   deploy/setup.sh --check       check a setup and say what to fix; exits 1 if anything needs fixing
#   deploy/setup.sh --update      back up the database, get the latest code (in a git clone), rebuild
#   deploy/setup.sh --admin-code  a new code that makes whoever uses it an admin, if every phone is lost
#
# On Windows, deploy\setup.cmd runs this in Git Bash and takes the same options.
#
# People get in with codes from a phone that's already in, so a server needs no sign-in provider.
# One is optional: Google (a client you make in Google Cloud) or any OpenID Connect provider.
#
# Flags, for setting up without questions (with --yes, anything missing is an error instead):
#   --url https://amble.example.com    the address people use, with its path if it has one
#   --timezone Area/City               the household's time zone (this computer's by default)
#   --port 18085                       the port on this computer the server listens on
#   --assistants yes|no                whether Claude and ChatGPT can reach the server: with a
#                                      Tailscale address, Tailscale Funnel puts it on the internet
#   --ai-provider NAME --ai-key-file PATH   optional: or set the AI model later in the app
#   --privacy-contact EMAIL            optional: shown on the app's /privacy page
# Optional, for signing in with a provider as well as codes:
#   --client-id ID                     the sign-in client's ID
#   --client-secret-file PATH          a file holding the sign-in client's secret
#   --issuer URL --provider-name NAME  another OpenID Connect provider (Google by default)
#   --admin you@example.com            who signs in as an admin, comma-separated
#   --allow partner@example.com        others who may sign in, comma-separated
set -euo pipefail
cd "$(dirname "$0")/.."
# How to run this again, for the hints it prints. deploy\setup.cmd names itself.
me=${AMBLE_SETUP_AS:-deploy/setup.sh}

mode=setup yes=0 problems=0 reachable=0
url='' admin='' allow='' client_id='' secret_file='' issuer='' provider='' tz='' port='' ai_provider='' ai_key_file='' privacy='' assistants=''
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
    --admin-code) mode=admin-code ;;
    --assistants) assistants=$(value "$@"); shift ;;
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
      sed -n '/^set -euo/q; 2,$p' "$0" | sed 's/^# \{0,1\}//'
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

url_host() {
  local h=${1#*://}
  h=${h%%/*}
  printf '%s' "${h%%:*}"
}
url_path() {
  local p=${1#*://}
  case "$p" in */*) printf '/%s' "${p#*/}" ;; esac
}
# A Tailscale name, on a computer with Tailscale, which can point it at the server itself.
tailscale_name() {
  case "$(url_host "$1")" in *.ts.net) command -v tailscale >/dev/null 2>&1 ;; *) return 1 ;; esac
}
# Tailscale as this user, or with sudo on Linux, where changing it usually needs root.
ts() {
  if tailscale "$@"; then return 0; fi
  if [ "$(id -u)" != 0 ] && [ "$(uname -s)" = Linux ] && command -v sudo >/dev/null 2>&1; then
    local asking=-n
    if [ "$yes" = 0 ] && [ -t 0 ]; then asking=; fi
    sudo $asking tailscale "$@"
  else
    return 1
  fi
}
# Whether Tailscale Funnel puts the server on the internet, where Claude and ChatGPT can reach it.
funnel_on() { tailscale funnel status 2>/dev/null | grep -q 'Funnel on' || sudo -n tailscale funnel status 2>/dev/null | grep -q 'Funnel on'; }

# A long random string, for what the server seals its keys under.
new_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32 | tr -d '\n'; else head -c 32 /dev/urandom | base64 | tr -d '\n'; fi
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
    bad "There's no .env here yet: run $me to make one."
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
  # secrets/ can belong to the container's user, and then only it (and root) can look inside.
  local sealed=0
  if [ -d secrets ] && [ ! -x secrets ]; then sealed=1; fi
  if [ -z "$id" ]; then
    ok "Sign-in: codes from a phone or computer that's already in (no sign-in provider)"
  else
    ok "Sign-in: codes, or $name with the client $id"
    if [ -n "$admins" ]; then ok "Admins who sign in with $name: $admins"; else bad "AMBLE_ADMIN_EMAILS isn't set in .env: your own email, so you can sign in with $name."; fi
    if [ -s secrets/oidc_client_secret ]; then
      ok "The sign-in client's secret is in secrets/oidc_client_secret"
    elif [ "$sealed" = 1 ]; then
      note "secrets/ belongs to the container's user, so this user can't look inside it; the server can."
    else
      bad "secrets/oidc_client_secret is missing or empty: put the sign-in client's secret in it."
    fi
  fi
  if [ ! -d data ]; then
    bad "There's no data/ folder: run $me."
  elif ! docker_desktop && ! owned_by_container; then
    bad "data/ and secrets/ have to belong to the container's user (uid 1000): sudo chown -R 1000:1000 data secrets"
  fi

  if local_health "$p"; then
    ok "The server is running on 127.0.0.1:$p"
  else
    bad "Nothing answers on 127.0.0.1:$p: start it with $me, and read docker compose logs amble if it won't start."
  fi

  # A Tailscale name can resolve to Funnel's public relay on a computer that doesn't use Tailscale's
  # DNS, and the relay only carries Funnel's ports; Tailscale itself says where the name really is.
  local via=() hostport host port tsip
  hostport=${u#*://}
  hostport=${hostport%%/*}
  host=${hostport%%:*}
  port=${hostport##*:}
  if [ "$port" = "$hostport" ]; then
    case "$u" in https://*) port=443 ;; *) port=80 ;; esac
  fi
  case "$host" in
    *.ts.net)
      if command -v tailscale >/dev/null 2>&1; then
        # By the machine's own name: given the whole name, tailscale ip asks that same DNS first.
        tsip=$(tailscale ip -4 "${host%%.*}" 2>/dev/null | head -1 || true)
        if [ -n "$tsip" ]; then via=(--resolve "$host:$port:$tsip"); fi
      fi
      ;;
  esac

  reachable=0
  if [ -n "$u" ] && curl "${via[@]}" -fsS --max-time 10 "$u/healthz" >/dev/null 2>&1; then
    reachable=1
    ok "Reachable at $u (from this computer)"
  elif [ -n "$u" ]; then
    bad "Not reachable at $u yet: point your reverse proxy or Tailscale at 127.0.0.1:$p (docs/self-hosting.md, step 4)."
  fi

  if tailscale_name "$u"; then
    if funnel_on; then
      ok "Claude and ChatGPT can reach it: Tailscale Funnel puts it on the internet"
    else
      note "Only your own devices on Tailscale reach $u, so Claude and ChatGPT can't. To let them: $me --assistants yes"
    fi
  fi

  local discovery reported
  if [ -z "$id" ]; then
    :
  elif discovery=$(curl -fsS --max-time 10 "${i%/}/.well-known/openid-configuration" 2>/dev/null); then
    reported=$(printf '%s' "$discovery" | tr -d '\n' | sed -n 's/.*"issuer"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ "$reported" = "$i" ]; then ok "Sign-in provider: $name ($i)"; else bad "OIDC_ISSUER is $i, but the provider calls itself $reported: copy that exactly, trailing slash and all."; fi
  else
    bad "Couldn't read the sign-in provider's settings at $i/.well-known/openid-configuration: check OIDC_ISSUER."
  fi

  # Google answers a sign-in for an address it doesn't know right away, so ask it.
  if [ -z "$id" ]; then
    :
  elif [ "$reachable" = 1 ] && [ "$i" = https://accounts.google.com ]; then
    local start page
    start=$(curl "${via[@]}" -sS -o /dev/null --max-time 10 -w '%{redirect_url}' "$u/auth/login?direct=1" 2>/dev/null || true)
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
  elif [ "$sealed" = 1 ]; then
    :
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

# A new code for an admin, for a household that lost every phone that was in.
if [ "$mode" = admin-code ]; then
  docker compose exec -T amble node server/pair.ts admin || die "Couldn't make a code. Is the server running? Start it with $me."
  exit
fi

if [ "$mode" = update ]; then
  [ -f .env ] || die "There's no .env here yet: run $me first."
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
tz=${tz:-$(env_get AMBLE_TIMEZONE)}
tz=${tz:-$(host_timezone)}
ask tz "The household's time zone, like America/Chicago or Europe/Berlin" "$tz"
[ -n "$tz" ] || die "A time zone is needed (--timezone), like America/Chicago."

# People get in with codes from a phone that's already in. A sign-in provider is optional, on top.
signin=codes
if [ -n "$client_id$issuer" ] || [ -n "$(env_get OIDC_CLIENT_ID)" ]; then signin=provider; fi
ask signin "How people get in: codes (nothing to set up) or provider (Google or your own, as well)" "$signin"
case "$signin" in
  codes) admin='' allow='' issuer='' provider='' client_id='' ;;
  provider)
    ask admin "Your email, to sign in as the admin (more, comma-separated)" "${admin:-$(env_get AMBLE_ADMIN_EMAILS)}"
    case "$admin" in *@*) ;; *) die "An admin email is needed (--admin)." ;; esac
    ask allow "Others in the household who may sign in (comma-separated, or none)" "${allow:-$(env_get AMBLE_ALLOWED_EMAILS)}"
    [ "$allow" = none ] && allow=
    issuer=${issuer:-$(env_get OIDC_ISSUER)}
    # Kept exactly as given: it has to match what the provider calls itself, trailing slash and all.
    ask issuer "The sign-in provider's issuer (Enter for Google)" "${issuer:-https://accounts.google.com}"
    provider=${provider:-$(env_get OIDC_PROVIDER_NAME)}
    if [ "$issuer" = https://accounts.google.com ]; then provider=${provider:-Google}; fi
    ask provider "The sign-in provider's name, for its button (\"Continue with ...\")" "$provider"
    [ -n "$provider" ] || die "A name for the sign-in provider is needed (--provider-name), like Authelia."
    ask client_id "The sign-in client's ID" "${client_id:-$(env_get OIDC_CLIENT_ID)}"
    [ -n "$client_id" ] || die "The sign-in client's ID is needed (--client-id): docs/sign-in.md."
    ;;
  *) die "Answer codes or provider." ;;
esac

# Claude and ChatGPT need the address on the internet; with Tailscale, that's Funnel.
if tailscale_name "$url"; then
  if [ -z "$assistants" ]; then
    assistants=no
    if funnel_on; then assistants=yes; fi
  fi
  ask assistants "Should Claude and ChatGPT be able to reach Amble? That puts the address on the internet with Tailscale Funnel; getting in still takes a code or a sign-in (yes/no)" "$assistants"
fi
case "${assistants:-no}" in yes | no) ;; *) die "Answer yes or no for --assistants." ;; esac
port=${port:-$(env_get AMBLE_PORT)}
port=${port:-18085}
privacy=${privacy:-$(env_get AMBLE_PRIVACY_CONTACT)}
ai_provider=${ai_provider:-$(env_get AMBLE_AI_PROVIDER)}

secret=
if [ "$signin" = codes ]; then
  :
elif [ -n "$secret_file" ]; then
  [ -s "$secret_file" ] || die "$secret_file is missing or empty."
  secret=$(tr -d '\r\n' <"$secret_file")
elif [ ! -s secrets/oidc_client_secret ] && { [ ! -d secrets ] || [ -x secrets ]; }; then
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
  if [ "$signin" = provider ]; then
    echo "AMBLE_ADMIN_EMAILS=$admin"
    echo "AMBLE_ALLOWED_EMAILS=$allow"
    echo "OIDC_ISSUER=$issuer"
    echo "OIDC_PROVIDER_NAME=$provider"
    echo "OIDC_CLIENT_ID=$client_id"
  fi
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
  # Once secrets/ belongs to the container's user, another user can't change what's in it.
  if [ ! -w secrets ]; then
    note "secrets/ belongs to the container's user, so secrets/$1 stays as it is. To change it: sudo cp <the file> secrets/$1"
    return
  fi
  (umask 077 && printf '%s' "$2" >"secrets/$1") 2>/dev/null || die "Couldn't write secrets/$1: run this as the folder's owner, or with sudo."
}
if [ -n "$secret" ]; then put_secret oidc_client_secret "$secret"; fi
if [ -n "$ai_key" ]; then put_secret ai_api_key "$ai_key"; fi
# What the server seals its keys under. A server that already seals them under its sign-in client's
# secret, or a secret it made itself in data/, keeps using that (server/lib/secret.ts).
if [ -w secrets ] && [ ! -s secrets/amble_secret ] && [ ! -s secrets/oidc_client_secret ] && [ ! -s data/secret ]; then
  put_secret amble_secret "$(new_secret)"
fi
ok "Secrets are in secrets/, readable only by their owner"
if ! docker_desktop && ! owned_by_container; then
  if [ "$(id -u)" = 0 ]; then
    chown -R 1000:1000 data secrets
  else
    note "The container runs as uid 1000, so data/ and secrets/ have to belong to it: sudo chown -R 1000:1000 data secrets"
    # Without someone at the keyboard, sudo can't ask for a password, so it isn't allowed to.
    asking=-n
    if [ "$yes" = 0 ] && [ -t 0 ]; then asking=; fi
    sudo $asking chown -R 1000:1000 data secrets || die "Couldn't hand data/ and secrets/ to uid 1000; run that sudo line yourself, then this script again."
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

# The Tailscale address, pointed at the server: serve for the household's own devices, funnel for
# the internet too. It may stop to give a link to turn HTTPS on the first time.
if tailscale_name "$url"; then
  if [ -n "$(url_path "$url")" ]; then
    note "The address has a path ($(url_path "$url")), so point Tailscale at it yourself: docs/self-hosting.md, step 4."
  else
    how=serve
    if [ "$assistants" = yes ]; then how=funnel; elif funnel_on; then ts funnel --https=443 off >/dev/null 2>&1 || true; fi
    if ts "$how" --bg "$port"; then
      ok "Tailscale ($how) sends $url to port $port"
    else
      note "Couldn't run tailscale $how. Run it yourself: sudo tailscale $how --bg $port (on Windows and Macs, without sudo)."
    fi
  fi
fi

echo
check
echo

# The first admin's code, while nobody's in yet. Once someone is, codes come from Amble's Settings.
coded=0
if [ "$reachable" = 1 ] || local_health "$port"; then
  echo "Getting in:"
  status=0
  docker compose exec -T amble node server/pair.ts first || status=$?
  case "$status" in
    0) coded=1 ;;
    3) ;;
    *) note "Couldn't make the first code. Run $me --admin-code once the server is up." ;;
  esac
  echo
fi

echo "Next:"
if [ "$reachable" = 0 ]; then
  echo "  - Make $url reach port $port on this computer (docs/self-hosting.md, step 4)."
  if [ "$signin" = provider ]; then echo "  - The sign-in client's redirect URI has to be exactly: $url/auth/callback"; fi
fi
if [ "$problems" != 0 ]; then
  echo "  - Fix what's marked [fix] above, and run $me --check until it passes."
fi
if [ "$coded" = 1 ]; then echo "  - Scan the code above in the Amble app (Use my own server, then Scan the code) to get in as the admin."; fi
echo "  - Add everyone else from Amble's Settings, Your server, Add a phone or computer."
if [ "$signin" = provider ]; then echo "  - Or open $url/server and sign in as ${admin%%,*}."; fi
if [ "${assistants:-no}" = yes ]; then echo "  - Connect Claude or ChatGPT: docs/assistants.md."; fi

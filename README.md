# Almanac

A calm, shared, self-hosted planner for a household. It knows how full each day already is, from your tasks and your Google Calendar, and suggests what to do today and which day has room for something due later. It never nags.

Status: early. Sign-in, the app shell, theming and the Claude connector work. The task screens, lists and the planner are next (see [SPEC.md](SPEC.md) for the plan and build order).

## Features so far

- Sign in with Google, or any OpenID Connect provider, limited to an allowlist of emails
- Installable app (PWA) designed in Material 3 Expressive, with its spring motion tokens
- Material You theming: pick any color and Almanac generates the full Material 3 palette (2025 spec) in five styles and three contrast levels, light, dark or automatic. It's saved per person and follows you across devices.
- A Claude connector (MCP) with its own OAuth sign-in: Claude can add, plan, complete and hand off tasks, keep shopping lists, and check how full each day is

## Run it locally

Needs Node 24+ and pnpm.

```sh
pnpm install
cp .env.example .env    # dev sign-in is on by default, so no OIDC setup is needed
pnpm dev                # http://localhost:5173
```

`pnpm test` runs the tests, including contrast checks for every theme. `node scripts/screens.ts <email>` captures every screen at phone size in several themes (needs `pnpm dev` running and Chrome installed).

## Use it from Claude

Almanac includes a Claude connector (MCP). Claude can add, plan, complete and hand off tasks, keep shopping lists, and check how full each day is, acting as whoever connected it.

**Remote (claude.ai, the desktop and phone apps, Claude Code).** Open Connect Claude from the account menu in Almanac and copy the address shown, which is `<ALMANAC_PUBLIC_URL>/mcp`. In Claude, go to Settings, Connectors, Add custom connector, paste it, then Connect and Allow. Almanac is its own OAuth 2.1 server: Claude identifies itself with its client metadata document, you sign in with your normal Almanac account, and you can disconnect from the same page. It needs a public HTTPS URL that Claude can reach, and if Almanac runs under a path prefix your proxy must also send `/.well-known/oauth-protected-resource<prefix>` and `/.well-known/oauth-authorization-server<prefix>` to it. Only apps on `ALMANAC_OAUTH_CLIENT_HOSTS` (default `claude.ai,claude.com`) and local loopback apps can connect.

**Local (same machine as the database).** `server/mcp-stdio.ts` talks to Claude over stdio and opens the database file directly, with no sign-in and nothing exposed to the network. It acts as the member named by `ALMANAC_MEMBER`, who must have signed in once:

```sh
claude mcp add almanac --scope user -e ALMANAC_MEMBER=you@example.com -- node /path/to/almanac/server/mcp-stdio.ts
```

For the Claude desktop app, add the same command under `mcpServers` in its config (Settings, Developer, Edit Config) and restart it. Set `ALMANAC_DATA_DIR` if the database isn't in the repo's `data/` folder.

## Self-host with Docker

```sh
cp .env.example .env    # set ALMANAC_PUBLIC_URL, the emails, OIDC_CLIENT_ID, and ALMANAC_DEV_LOGIN=0
mkdir -p data secrets
printf '%s' 'your-client-secret' > secrets/oidc_client_secret
docker compose up -d --build
```

The app listens on `127.0.0.1:18085` (change with `ALMANAC_PORT`); put your reverse proxy in front of it. It can run under a path prefix: set `ALMANAC_PUBLIC_URL` to the full URL, for example `https://example.com/almanac`, and the proxy may pass the prefix through or strip it.

For Google sign-in, create an OAuth client of type "Web application" with the redirect URI `<ALMANAC_PUBLIC_URL>/auth/callback`, and set the consent screen's publishing status to "In production" so sessions with Calendar access don't expire after 7 days.

Back up `data/`. `node server/backup.ts` inside the container writes a consistent copy of the database to `data/snapshots/almanac-latest.db` for file-level backups.

## License

[AGPL-3.0](LICENSE)

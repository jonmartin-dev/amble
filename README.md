# Almanac

A calm, shared, self-hosted planner for a household. It knows how full each day already is, from your tasks and your Google Calendar, and suggests what to do today and which day has room for something due later. It never nags.

Status: early. Sign-in, the app shell and theming work. Tasks, lists, the planner and the Claude connector are next (see [SPEC.md](SPEC.md) for the plan and build order).

## Features so far

- Sign in with Google, or any OpenID Connect provider, limited to an allowlist of emails
- Installable app (PWA) designed in Material 3 Expressive, with its spring motion tokens
- Material You theming: pick any color and Almanac generates the full Material 3 palette (2025 spec) in five styles and three contrast levels, light, dark or automatic. It's saved per person and follows you across devices.

## Run it locally

Needs Node 24+ and pnpm.

```sh
pnpm install
cp .env.example .env    # dev sign-in is on by default, so no OIDC setup is needed
pnpm dev                # http://localhost:5173
```

`pnpm test` runs the tests, including contrast checks for every theme. `node scripts/screens.ts <email>` captures every screen at phone size in several themes (needs `pnpm dev` running and Chrome installed).

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

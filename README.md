# Almanac

A calm, shared, self-hosted planner for a household. It knows how full each day already is, from your tasks and your Google Calendar, and suggests what to do today and which day has room for something due later. It never nags.

Status: early but usable. The day list, backlog, task details, smart add, repeating tasks, list templates, handing tasks to each other, the calendar, stats, the activity feed, settings and the Claude connector work, offline too, and capacity is learned from what gets done. The calendar-aware planner is next (see [SPEC.md](SPEC.md) for the plan and build order).

## Features so far

- Today: your day list by time of day, a load meter, what carried over and what's due. Swipe right to finish a task, swipe left or long-press to move it, with Undo for both
- Backlog in collapsible groups with search, a quick-add sheet, and a task page for notes, steps, links, deadlines, time of day, must-do and estimates
- Moving a task shows the next two weeks with how full each day already is
- Smart add: type anything into quick add ("call mom tomorrow evening, out of milk and eggs, Alex should mow every Saturday") and Claude Haiku turns it into tasks, list items and changes to existing tasks, using what's already in the household. You review and edit each one before anything is saved. Optional; it needs an Anthropic API key and has a monthly spending cap
- Repeating tasks: on a schedule (every Sunday, the 1st, the 2nd Thursday, weekdays, seasonal months) or a set time after the last one was done, with skip and pause
- Capacity learned from what each person finishes, so how full a day looks needs no setup; anyone can pin their own numbers
- Lists from templates: groceries sorted by aisle, shopping with links and prices, packing lists that reset for the next trip, with autocomplete from what you've bought before
- A household: hand tasks to each other with a note, or share them with anyone; admins add people before they've signed in
- Sign in with Google, or any OpenID Connect provider, limited to an allowlist of emails
- Works offline: the app and what you last loaded open without a connection, changes show at once and sync in order when you're back, and if someone changed the same thing in the meantime the later change wins
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

`pnpm test` runs the tests, including contrast checks for every theme. `node --env-file=.env scripts/eval-smart-add.ts` scores smart add against real household phrasing at each effort level (it calls Haiku, a fraction of a cent per case). For a realistic household to look at, `node scripts/demo.ts <empty-folder> <your-email>` writes a demo database; run the app on it with `ALMANAC_DATA_DIR=<that-folder> pnpm dev`. With that running (and Chrome installed), `node scripts/screens.ts <email>` captures every screen at phone size in several themes, and `node scripts/smoke.ts <email>` clicks through the core loop and fails on any broken step or console error. Offline needs the service worker, which only a production build has: run `pnpm build`, start `node --env-file=.env server/index.ts` on the demo database, and `ALMANAC_URL=http://localhost:8787 node scripts/offline.ts <email>` goes offline, makes changes, comes back and checks they synced.

## Use it from Claude

Almanac includes a Claude connector (MCP). Claude can add, plan, complete and hand off tasks, keep shopping lists, and check how full each day is, acting as whoever connected it.

**Remote (claude.ai, the desktop and phone apps, Claude Code).** Open Connect Claude from the account menu in Almanac and copy the address shown, which is `<ALMANAC_PUBLIC_URL>/mcp`. In Claude, go to Settings, Connectors, Add custom connector, paste it, then Connect and Allow. Almanac is its own OAuth 2.1 server: Claude identifies itself with its client metadata document, you sign in with your normal Almanac account, and you can disconnect from the same page. It needs a public HTTPS URL that Claude can reach, and if Almanac runs under a path prefix your proxy must also send `/.well-known/oauth-protected-resource<prefix>` and `/.well-known/oauth-authorization-server<prefix>` to it. Only apps on `ALMANAC_OAUTH_CLIENT_HOSTS` (default `claude.ai,claude.com`) and local loopback apps can connect.

**Local (same machine as the database).** `server/mcp-stdio.ts` talks to Claude over stdio and opens the database file directly, with no sign-in and nothing exposed to the network. It acts as the member named by `ALMANAC_MEMBER`, who must have signed in once:

```sh
claude mcp add almanac --scope user -e ALMANAC_MEMBER=you@example.com -- node /path/to/almanac/server/mcp-stdio.ts
```

For the Claude desktop app, add the same command under `mcpServers` in its config (Settings, Developer, Edit Config) and restart it. Set `ALMANAC_DATA_DIR` if the database isn't in the repo's `data/` folder.

**The Almanac skill.** `skill/almanac/` teaches Claude how to use the connector the calm way: what goes in the backlog versus on a day, keeping days light, lists versus tasks, and short replies. Zip that folder and upload it in Claude under Customize, Skills, or copy it into a local skills folder with `node scripts/sync-skill.ts <skills-dir>`. Remove its Household notes section first; that part describes one household.

## Self-host with Docker

```sh
cp .env.example .env    # set ALMANAC_PUBLIC_URL, the emails, OIDC_CLIENT_ID, and ALMANAC_DEV_LOGIN=0
mkdir -p data secrets
printf '%s' 'your-client-secret' > secrets/oidc_client_secret
printf '%s' 'sk-ant-...' > secrets/anthropic_api_key   # optional, for smart add
docker compose up -d --build
```

The app listens on `127.0.0.1:18085` (change with `ALMANAC_PORT`); put your reverse proxy in front of it. It can run under a path prefix: set `ALMANAC_PUBLIC_URL` to the full URL, for example `https://example.com/almanac`, and the proxy may pass the prefix through or strip it.

For Google sign-in, create an OAuth client of type "Web application" with the redirect URI `<ALMANAC_PUBLIC_URL>/auth/callback`, and set the consent screen's publishing status to "In production" so sessions with Calendar access don't expire after 7 days.

Back up `data/`. `node server/backup.ts` inside the container writes a consistent copy of the database to `data/snapshots/almanac-latest.db` for file-level backups.

## License

[AGPL-3.0](LICENSE)

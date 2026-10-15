# Almanac

A calm, shared planner for a household. It knows how full each day already is, from your tasks and your Google Calendar, and suggests what to do today and which day has room for something due later. It never nags.

Status: early but usable. The day list, backlog, task details, smart add, repeating tasks, lists from eleven templates, handing tasks to each other, the calendar, stats, the activity feed, settings and the connector for Claude and ChatGPT work, offline too. Capacity is learned from what gets done, Google Calendar shapes how full each day is, and the planner suggests what to do today and where things fit. Reminders and files on tasks work too. It also runs with no server at all, on the device or as an Android app, and keeps a household in step through Google Drive.

<p>
  <img src="docs/screenshots/briefing.png" width="160" alt="Here's today: the day's load, calendar events, a task handed over and a suggestion">
  <img src="docs/screenshots/today.png" width="160" alt="Today: the day's tasks by morning, afternoon, evening and anytime">
  <img src="docs/screenshots/calendar.png" width="160" alt="Calendar: a week of load bars, with tasks due soon and the day that has room for each">
  <img src="docs/screenshots/task.png" width="160" alt="A task's page: day, time of day, deadline, reminder, repeat, group and person">
  <img src="docs/screenshots/groceries.png" width="160" alt="Groceries in dark mode, sorted by aisle with quantities">
  <img src="docs/screenshots/lists.png" width="160" alt="A new list: eleven templates, from groceries and packing to gift ideas and a meal plan">
  <img src="docs/screenshots/quick-add.png" width="160" alt="Quick add: what's typed in large type, with a row of chips for the day, group and person">
  <img src="docs/screenshots/appearance.png" width="160" alt="Appearance: Material You colors and styles, light, dark or automatic">
</p>

## Features so far

- Here's today: the first open each morning shows how full the day is, what's on your calendar, what someone handed you, and a few backlog tasks worth pulling in, each with a reason. Nothing changes until you tap Add
- Today: your day list by time of day, a load meter, what carried over and what's due. Swipe right to finish a task, swipe left or long-press to move it, with Undo for both
- Google Calendar: each person connects their own and picks which calendars count. A day with more on it than usual has less room for tasks, and the calendar shows your events next to your tasks. It only reads
- Planning help: a task due later shows the day with the most room before it, Plan my week lays out the next seven days around your calendar (tell it "keep Saturday free" and it does), and Tidy up suggests regrouping, merging duplicates and splitting tasks that are really several
- Backlog in collapsible groups with search, a quick-add sheet, and a task page for notes, steps, links, files, deadlines, time of day, must-do and estimates
- Reminders, only when you ask: pick a time on a task (or say "remind me Thursday at 6" in quick add) and get one notification on your phone, with Done and Snooze on it. Nothing else in Almanac ever notifies you
- Files on tasks: photos, receipts, manuals and PDFs, up to 25 MB each, kept on your own server
- Moving a task shows the next two weeks with how full each day already is
- Smart add: type anything into quick add ("call mom tomorrow evening, out of milk and eggs, Alex should mow every Saturday") and an AI model turns it into tasks, list items and changes to existing tasks, using what's already in the household. You review and edit each one before anything is saved. Optional, and it works with any provider's key: Claude Haiku, GPT-6 Luna, Gemini Flash-Lite or GLM Flash (both with free tiers), anything on OpenRouter, or a model on your own machine through Ollama or LM Studio. Set it up in Settings, AI, with a monthly spending cap
- Repeating tasks: on a schedule (every Sunday, the 1st, the 2nd Thursday, weekdays, seasonal months) or a set time after the last one was done, with skip and pause
- Capacity learned from what each person finishes, so how full a day looks needs no setup; anyone can pin their own numbers. Tasks without a size get one from the AI model in the background, and Stats shows how good its guesses are
- Lists from eleven templates: groceries that sort themselves by aisle as you type, shopping with links, prices and stores, packing lists from a kit that reset for the next trip, private gift ideas by person, errands by place, a meal plan whose ingredients go to Groceries in one tap, the hardware store, things to watch and read, places to try, and routines. Tap an item to check it off, hold it to change it, and change any list's sections. A grocery run plans as one task on the day with room, and shows what's left on the list
- A household: hand tasks to each other with a note, or share them with anyone; admins add people before they've signed in
- Sign in with Google, or any OpenID Connect provider, limited to an allowlist of emails
- Works offline: the app and what you last loaded open without a connection, changes show at once and sync in order when you're back, and if someone changed the same thing in the meantime the later change wins
- Installable app (PWA) designed in Material 3 Expressive, with its spring motion tokens. It fits the screen it's on: a floating toolbar on phones, a navigation rail on a foldable or small tablet, and on wider screens a task or list opens beside the page you picked it from
- Material You theming: pick any color and Almanac generates the full Material 3 palette (2025 spec) in five styles and three contrast levels, light, dark or automatic. It's saved per person and follows you across devices.
- No server needed: the same app runs entirely on your device, with nothing to sign up for, and can back itself up to your Google Drive and share a household through it. Only the assistant connector needs a server
- A connector (MCP) for Claude and ChatGPT with its own OAuth sign-in: either can add, plan, complete and hand off tasks, keep shopping lists, check how full each day is, suggest what to do today, draft a week's plan, set reminders you ask for and look at photos on tasks

## Run it locally

Needs Node 26+ (for its built-in `Temporal`) and pnpm.

```sh
pnpm install
cp .env.example .env    # dev sign-in is on by default, so no OIDC setup is needed
pnpm dev                # http://localhost:5173
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, the checks to run and how the code is written. `pnpm test` runs the tests, including contrast checks for every theme. `node --env-file=.env scripts/eval-smart-add.ts` scores smart add against real household phrasing at each effort level, on the model the environment sets (a fraction of a cent per case). For a realistic household to look at, `node scripts/demo.ts <empty-folder> <your-email>` writes a demo database; run the app on it with `ALMANAC_DATA_DIR=<that-folder> pnpm dev`. With that running (and Chrome installed), `node scripts/screens.ts <email>` captures every screen at phone size in several themes (`ALMANAC_VIEWPORT=820x1180` for a tablet), and `node scripts/smoke.ts <email>` clicks through the core loop and fails on any broken step or console error. The demo includes a sample calendar, so the briefing and planner have events to work around. Offline needs the service worker, which only a production build has: run `pnpm build`, start `node --env-file=.env server/index.ts` on the demo database, and `ALMANAC_URL=http://localhost:8787 node scripts/offline.ts <email>` goes offline, makes changes, comes back and checks they synced.

## Run it with no server

```sh
pnpm dev:device        # http://localhost:5174
pnpm build:device      # static files in dist/device, for any static host
```

This build runs Almanac's API in a web worker on the device, on SQLite compiled to WebAssembly and kept in the browser's own storage. First open asks what to call you and starts; nothing leaves the device. Settings, Sync and backup keeps a copy in your Google Drive and brings your other devices and your household in step, with no server in between. AI features work too, with a key that stays on the device. [docs/google-drive.md](docs/google-drive.md) covers building it with a Google client, the Google Cloud setup, and adding a server to a household later.

The same build is the Android app, through Capacitor: reminders show with the app closed, and Drive sync keeps going without asking you to sign in again. `node scripts/android.ts run` builds it and installs it on a plugged-in phone; [docs/android.md](docs/android.md) has what it needs.

## Use it from Claude or ChatGPT

Almanac's server includes a connector (MCP) that Claude and ChatGPT can both use. They can add, plan, complete and hand off tasks, keep shopping lists, and check how full each day is, acting as whoever connected them. Activity shows which assistant made each change.

Both connect to the same address: open Connect an assistant from Settings (under AI) in Almanac and copy it. It's `<ALMANAC_PUBLIC_URL>/mcp`.

**Claude (claude.ai, the desktop and phone apps, Claude Code).** In Claude, go to Settings, Connectors, Add custom connector, paste the address, then Connect and Allow.

**ChatGPT (on the web, in Developer mode).** In ChatGPT, turn on Developer mode under Settings, Apps, Advanced settings. Then choose Create in Apps, paste the address, pick OAuth, and Allow on the Almanac page that opens. Developer mode is a beta: as of October 2026 ChatGPT can use every tool on Business, Enterprise and Edu plans, and only the read-only ones on Pro. ChatGPT identifies itself with its client metadata document (`https://chatgpt.com/oauth/client.json`) and comes back to `https://chatgpt.com/connector_platform_oauth_redirect`; dynamic registration works too, if it's picked in the app's OAuth settings. Nobody has connected a real ChatGPT account yet, so if you do, [say how it went](CONTRIBUTING.md#help-wanted).

Almanac is its own OAuth 2.1 server: the assistant identifies itself, you sign in with your normal Almanac account, and you can disconnect from the same page. It needs a public HTTPS URL the assistant can reach, and if Almanac runs under a path prefix your proxy must also send `/.well-known/oauth-protected-resource<prefix>` and `/.well-known/oauth-authorization-server<prefix>` to it. Only apps on `ALMANAC_OAUTH_CLIENT_HOSTS` (default `claude.ai,claude.com,chatgpt.com`) and local loopback apps can connect. If your `.env` sets that list from an older `.env.example`, add `chatgpt.com` to it.

**Local (same machine as the database).** ChatGPT only connects to remote servers, but Claude can also run Almanac locally. `server/mcp-stdio.ts` talks to Claude over stdio and opens the database file directly, with no sign-in and nothing exposed to the network. It acts as the member named by `ALMANAC_MEMBER`, who must have signed in once:

```sh
claude mcp add almanac --scope user -e ALMANAC_MEMBER=you@example.com -- node /path/to/almanac/server/mcp-stdio.ts
```

For the Claude desktop app, add the same command under `mcpServers` in its config (Settings, Developer, Edit Config) and restart it. Set `ALMANAC_DATA_DIR` if the database isn't in the repo's `data/` folder.

**The Almanac skill.** `skill/almanac/` teaches Claude how to use the connector the calm way: what goes in the backlog versus on a day, keeping days light, lists versus tasks, and short replies. Zip that folder and upload it in Claude under Customize, Skills, or copy it into a local skills folder with `node scripts/sync-skill.ts <skills-dir>`. To tell Claude about your own household (who's who, your time zone, what you'd rather not hear about), write it under a `## Household notes` heading in `skill/household.md`. Git ignores that file, and `sync-skill.ts` adds it to the end of the skill it copies.

## Self-host with Docker

```sh
cp .env.example .env    # set ALMANAC_PUBLIC_URL, the emails, OIDC_CLIENT_ID, and ALMANAC_DEV_LOGIN=0
mkdir -p data secrets
printf '%s' 'your-client-secret' > secrets/oidc_client_secret
printf '%s' 'sk-ant-...' > secrets/anthropic_api_key   # optional, for smart add, estimates and planning help
docker compose up -d --build
```

The app listens on `127.0.0.1:18085` (change with `ALMANAC_PORT`); put your reverse proxy in front of it. It can run under a path prefix: set `ALMANAC_PUBLIC_URL` to the full URL, for example `https://example.com/almanac`, and the proxy may pass the prefix through or strip it.

For Google sign-in, create an OAuth client of type "Web application" with the redirect URI `<ALMANAC_PUBLIC_URL>/auth/callback`, and set the consent screen's publishing status to "In production" so sessions with Calendar access don't expire after 7 days. Any other OpenID Connect provider works too; [docs/sign-in.md](docs/sign-in.md) has the steps for Authelia, Authentik and Keycloak, and what to check when sign-in fails. Set `ALMANAC_PRIVACY_CONTACT` to put a contact on the public `/privacy` page, which Google's consent screen links to.

Back up `data/`: it holds the database and `files/`, the files people add to tasks. `node server/backup.ts` inside the container writes a consistent copy of the database to `data/snapshots/almanac-latest.db` for file-level backups.

A household that syncs through Google Drive can have the server as one more copy, so the connector sees and changes the same things as everyone's phones: an admin connects it in Settings, Sync with Google Drive ([docs/google-drive.md](docs/google-drive.md)).

Reminders reach phones through web push. Almanac makes its push keys on first start and keeps them in the database, so there's nothing to configure; people turn notifications on per device in Settings, Notifications. On iPhone and iPad that works once Almanac is added to the home screen.

## Contributing

Bug reports and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE)

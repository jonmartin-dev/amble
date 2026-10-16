# Contributing

Thanks for wanting to help with Amble. It's a small project for households, built to stay calm: it never nags, keeps days light, and does nothing behind anyone's back. For a bigger change, open an issue first so we can talk it through.

## Principles

Every change should keep these true:

1. **Calm by default.** No red overdue counts, no badges, no notifications nobody asked for. Overdue things quietly come back as suggestions.
2. **Suggest, never move.** The planner and the AI features propose; nothing changes until a person taps Add or Accept. An assistant (Claude or ChatGPT) acting through the connector at someone's request is the one exception.
3. **Load-aware.** Every suggestion respects how full a day already is, calendar included.
4. **Shared household, private when wanted.** Everything is shared unless a group is marked private.
5. **Yours to keep.** On a device with nothing to host, or one container with one SQLite file; config in environment variables. Nothing about one household's setup is hard-coded.

## Getting started

You need Node 26 or newer (the server uses the built-in `Temporal`), pnpm, and Chrome for the browser checks.

```sh
pnpm install
cp .env.example .env     # dev sign-in is on, so no OIDC provider is needed
pnpm dev                 # the app on http://127.0.0.1:5174, the server on 8787 behind it
```

The app runs on the device even here: its API runs in a worker in the browser, on SQLite in WebAssembly. To try syncing with the server, choose Use my own server and enter `127.0.0.1:5174`. With dev sign-in on, the server's sign-in page offers "sign in as" for everyone in `AMBLE_ADMIN_EMAILS`, `AMBLE_ALLOWED_EMAILS` and its database, or `dev@amble.local` when there's nobody yet. [docs/google-drive.md](docs/google-drive.md) has what sync through Google Drive needs. `node scripts/android.ts run` builds the Android app and puts it on a plugged-in phone or an emulator ([docs/android.md](docs/android.md)).

For something to look at, build the demo household in an empty folder and run the built app on it, served by the server:

```sh
node scripts/demo.ts ../amble-demo sam@example.com
pnpm build
AMBLE_PUBLIC_URL=http://localhost:8787 AMBLE_DATA_DIR=../amble-demo node --env-file=.env server/index.ts
```

Then open http://localhost:8787, choose Use my own server, and sign in as Sam.

Smart add, estimates and the planner's wording need an AI model: set one up in Settings, AI, or on the server in `.env` (see `.env.example`) for devices that sync with it. Any provider works, including a local model through Ollama with no key. Without one, quick add takes text as typed and everything else still works. New AI features go through `ask()` in `server/ai/client.ts`, which meters every call and works with every provider; don't call a provider's SDK directly.

## Layout

| Folder | What's in it |
|---|---|
| `server/` | The API (`api.ts`), which runs on the device and in tests, and the server: sign-in (`auth/`), its own pages (`site.ts`, `pages.ts`), the connector for Claude and ChatGPT (`connector.ts`, `oauth/`, `mcp/`), AI features and their providers (`ai/`), reminders (`notify/`), the scheduler (`jobs.ts`) and the database (`db/`) |
| `server/domain/` | The rules for tasks, lists, repeats, load and planning, shared by the API and the connector |
| `server/sync/` | Sync between copies: recording changes (`capture.ts`), merging them (`state.ts`), the rounds with Drive or a server (`service.ts`), the server's own Drive sync (`server.ts`), and devices syncing with the server (`hub.ts`) |
| `server/local.ts`, `web/src/worker/` | Amble on the device: the API in a web worker on SQLite in WebAssembly (`server/db/wasm.ts`) |
| `android/`, `web/src/lib/native.ts`, `capacitor.config.ts` | The Android app: Capacitor around the web app, with the phone's own notifications, calendars (`PhoneCalendarPlugin.java`), background check (`ReminderCheck.java`) and Google sign-in (`GoogleDrivePlugin.java`) |
| `shared/` | Code the server and the app both use: list templates, repeat rules, smart add proposals |
| `web/src/` | The React app: `pages/`, `components/`, `lib/` (queries, writes to the device's database, theming, motion) and the service worker (`sw.ts`) |
| `drizzle/` | Database migrations, applied when Amble starts, on a device or the server |
| `skill/amble/` | The Claude skill that teaches Claude to use the connector the calm way |
| `scripts/` | Demo data, screenshots, browser checks and the smart add eval |
| `docs/` | Guides for self-hosters |

A new list template makes a good first change: one entry in `shared/templates.ts`, plus its icon in `GROUP_ICONS` (`server/domain/household.ts`) and `web/src/components/icons.tsx`. The tests check that the three agree.

## Help wanted

- **An iPhone app.** On an iPhone, Amble runs in the browser from a household's server, so a household without one can't use it there. The Android app is Capacitor around the web app, so an iOS project (`pnpm exec cap add ios`) gets most of the way. What's left is the native parts, which are Android-only today (`android/app/src/main/java/dev/jonmartin/amble/`): reminders with the app closed, the background check for reminders set elsewhere, reading the phone's calendars, Google sign-in for Drive, the code scanner and the home-screen widget. It needs a Mac with Xcode, and Apple's developer program to put it on phones other than your own.
- **Connect a real ChatGPT account.** The ChatGPT side of the connector follows OpenAI's auth docs and is tested against ChatGPT's real client metadata document, but nobody has signed in from ChatGPT itself yet. If your plan has Developer mode (Business, Enterprise or Edu to make changes, Pro to read), follow the ChatGPT steps on Connect an assistant against your own Amble, ask `@Amble` to add a task, and check that Activity says "via ChatGPT". Open an issue with how it went, especially any error during sign-in or the tool scan.
- **Sign in with ChatGPT.** OpenAI has a preview that lets people use their ChatGPT plan in other apps instead of an API key, through the Responses API (with `store: false` and streaming). It's built for local tools that sign in through a loopback address, and each app has to ask OpenAI for a client id, so nobody knows yet whether an open-source app like Amble can use it. Finding out would help as much as building it; the AI providers are in `shared/ai.ts` and `server/ai/client.ts`. Claude subscriptions can't be used this way, since Anthropic's terms keep them to Claude's own apps, so Claude stays on API keys.

## Before you open a pull request

```sh
pnpm typecheck
pnpm test
pnpm test:wasm
```

All three must pass. `test:wasm` runs the same tests on the WebAssembly SQLite the app uses on a device. For changes people can see, also run the built app on a fresh demo household (see [Getting started](#getting-started)) and use these. Each starts a fresh browser that joins the household through the server, as a new device would; `AMBLE_URL` points them at another address.

- `node scripts/smoke.ts sam@example.com` clicks through the core loop at phone size and fails on any broken step or console error. It changes the demo data, and some steps expect a fresh demo.
- `node scripts/screens.ts` captures every screen at phone size in several themes into `design/screens/` (not committed), for looking over a change in light and dark. Set `AMBLE_VIEWPORT=820x1180` to capture at tablet size.
- `node scripts/readme-shots.ts` retakes the screenshots in the README, if the screens they show changed.

`scripts/eval-smart-add.ts` scores smart add against real household phrasing. It calls the model the environment sets, so it costs a little; run it when you change smart add's prompt or schema.

## Database changes

Change `server/db/schema.ts`, run `pnpm db:generate`, and commit the new migration in `drizzle/` with it. Migrations run on start, on databases people already have, so they must keep existing data working.

Sync has a few rules of its own:

- A new table with household data goes in `server/sync/tables.ts`, or it won't reach other devices. Columns that belong to one copy (whether this device showed a reminder) are listed there as local.
- A row two devices could each make on their own (the next task a repeating one makes, a person's reminder on a task) gets an id worked out from what it is (`server/lib/ids.ts`), so it merges instead of showing up twice.
- A rule that spans rows, like one open task per repeating series, can be broken by two devices keeping it separately; `reconcile()` in `server/sync/state.ts` puts it right after a merge, the same way on every copy.
- Changes are recorded by triggers and timed once per request. Anything that writes outside a request (a background job) calls the sync service's `stamp()` after.

## How the code is written

- TypeScript, strict. Node runs the server's `.ts` files directly, so only syntax that type stripping can erase is allowed: no enums, namespaces or parameter properties. Imports name their `.ts` files.
- Match the code around you: its naming, its comment density, its idioms. Comments say why, not what.
- Dates on the server use `Temporal`. A person's day turns over at their cutoff hour (4am by default) in their time zone; use the helpers in `server/lib/dates.ts` rather than raw dates.
- The app must stay smooth on a mid-range phone. Animate only `transform` and `opacity` for anything frequent; growing a bar or sliding a sheet from JavaScript repaints every frame. No view transitions between screens. Reuse one `Intl.DateTimeFormat` per set of options rather than calling `toLocaleDateString`. The four tabs stay built in React `<Activity>` boundaries, so hidden tabs keep their elements in the page and tests look for visible ones. Measure at 4x CPU slowdown in Chrome when you touch anything on a hot path.
- Everything in the app works offline, since the API runs on the device; only AI features and sync need a connection. A change shows at once (`web/src/lib/local.ts`) and is written straight to the device's database, in order (`web/src/lib/sync.ts`). The only queue is the service worker's mailbox (`web/src/lib/outbox.ts`) for a reminder's Done or Snooze tapped while Amble was closed.

## Words in the app

Amble talks like a thoughtful person in the household: plain words, short sentences, no exclamation marks, no guilt. "Saturday looks heavy" rather than "You're overcommitted!". It only notifies people when they asked for a reminder. New features shouldn't add notifications, badges or streak pressure.

## Commits and pull requests

Keep a pull request to one change, and say in its description what changes for the people using Amble and how you checked it. Commit messages are short, lowercase and plain: "add reminders to the task page", "fix the backlog search on phones".

## Security

Please report security problems privately through the repository's Security tab rather than in a public issue.

## License

Amble is [AGPL-3.0](LICENSE). By contributing, you agree that your contributions are licensed under it too.

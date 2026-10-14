# Contributing

Thanks for wanting to help with Almanac. It's a small project for households, built to stay calm: it never nags, keeps days light, and does nothing behind anyone's back. [SPEC.md](SPEC.md) has the principles, the data model and the plan, and is the first thing to read before a bigger change.

## Getting started

You need Node 26 or newer (the server uses the built-in `Temporal`), pnpm, and Chrome for the browser checks.

```sh
pnpm install
cp .env.example .env     # dev sign-in is on, so no OIDC provider is needed
pnpm dev                 # the app on http://localhost:5173, the server on 8787
```

With dev sign-in on, the sign-in page offers a "sign in as" picker: everyone in `ALMANAC_ADMIN_EMAILS`, `ALMANAC_ALLOWED_EMAILS` and the database, or `dev@almanac.local` when there's nobody yet.

For something to look at, build the demo household in an empty folder and run the app on it:

```sh
node scripts/demo.ts ../almanac-demo sam@example.com
ALMANAC_DATA_DIR=../almanac-demo pnpm dev
```

Smart add, estimates and the planner's wording need `ANTHROPIC_API_KEY`. Without one, quick add takes text as typed and everything else still works.

## Layout

| Folder | What's in it |
|---|---|
| `server/` | The Hono server: the API (`api.ts`), sign-in (`auth/`), the Claude connector (`connector.ts`, `oauth/`, `mcp/`), Google Calendar (`calendar/`), web push (`notify/`), Haiku features (`ai/`), the scheduler (`jobs.ts`) and the database (`db/`) |
| `server/domain/` | The rules for tasks, lists, repeats, load and planning, shared by the API and the connector |
| `shared/` | Code the server and the app both use: list templates, repeat rules, smart add proposals |
| `web/src/` | The React app: `pages/`, `components/`, `lib/` (queries, the offline outbox, theming, motion) and the service worker (`sw.ts`) |
| `drizzle/` | Database migrations, applied when the server starts |
| `skill/almanac/` | The Claude skill that teaches Claude to use the connector the calm way |
| `scripts/` | Demo data, screenshots, browser checks and the smart add eval |
| `docs/` | Guides for self-hosters |

## Before you open a pull request

```sh
pnpm typecheck
pnpm test
```

Both must pass. For changes people can see, also run the app on a demo household and use these:

- `node scripts/smoke.ts <email>` clicks through the core loop at phone size and fails on any broken step or console error. It changes the demo data.
- `node scripts/screens.ts <email>` captures every screen at phone size in several themes into `design/screens/` (not committed), for looking over a change in light and dark.
- `node scripts/offline.ts <email>` checks offline use end to end. It needs a production build; the comment at the top of the script says how to run it.
- `node scripts/readme-shots.ts` retakes the screenshots in the README, if the screens they show changed.

`scripts/eval-smart-add.ts` scores smart add against real household phrasing. It calls Haiku, so it costs a little; run it when you change smart add's prompt or schema.

## Database changes

Change `server/db/schema.ts`, run `pnpm db:generate`, and commit the new migration in `drizzle/` with it. Migrations run on start, on databases people already have, so they must keep existing data working.

## How the code is written

- TypeScript, strict. Node runs the server's `.ts` files directly, so only syntax that type stripping can erase is allowed: no enums, namespaces or parameter properties. Imports name their `.ts` files.
- Match the code around you: its naming, its comment density, its idioms. Comments say why, not what.
- Dates on the server use `Temporal`. A person's day turns over at their cutoff hour (4am by default) in their time zone; use the helpers in `server/lib/dates.ts` rather than raw dates.
- The app must stay smooth on a mid-range phone. The rules that keep it that way are under Performance in [SPEC.md](SPEC.md#settled): animate only `transform` and `opacity` for anything frequent, no view transitions between screens, and measure at 4x CPU slowdown in Chrome when you touch anything on a hot path.
- Every change in the app works offline or says it needs a connection. Changes go through the outbox (`web/src/lib/outbox.ts`), not straight to `fetch`.

## Words in the app

Almanac talks like a thoughtful person in the household: plain words, short sentences, no exclamation marks, no guilt. "Saturday looks heavy" rather than "You're overcommitted!". It only notifies people when they asked for a reminder. New features shouldn't add notifications, badges or streak pressure.

## Commits and pull requests

Keep a pull request to one change, and say in its description what changes for the people using Almanac and how you checked it. Commit messages are short, lowercase and plain: "add reminders to the task page", "fix the backlog search on phones".

## Security

Please report security problems privately through the repository's Security tab rather than in a public issue.

## License

Almanac is [AGPL-3.0](LICENSE). By contributing, you agree that your contributions are licensed under it too.

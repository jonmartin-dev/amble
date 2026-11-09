# AGENTS.md

For AI agents working in this repository. There are two jobs here: setting Amble up for a person, and changing its code. People should start with the [README](README.md).

## What Amble is

A free planner for a household. Everything runs on the device: the app's API runs in a web worker on SQLite in WebAssembly, inside the Android app (Capacitor around the web app) or a browser. There's no account and no Amble service to sign up for. A household server is optional: one Docker container that adds what only a server can do.

## Setting Amble up for someone

Find out what they want before you install anything. Most people only need the Android app, and then there's nothing to run.

| They want | What to do |
|---|---|
| Amble on an Android phone | Join the Google Play closed test (the README says how), or build the app: [docs/android.md](docs/android.md) |
| Claude using their tasks, Amble on an iPhone or a computer, photos shared between phones, or sync without Google | A household server, below |
| The web app as static files, with no server | [docs/self-hosting.md](docs/self-hosting.md#just-the-web-app-with-no-server) |
| To change the code | [Working on the code](#working-on-the-code) |

### A household server

[docs/self-hosting.md](docs/self-hosting.md) is the full guide. Follow it in order and use this as the checklist.

1. Check what's needed: a computer that stays on, with Docker and Docker Compose running. On Windows, Git for Windows too, since the setup script runs in Git Bash. And an address their devices can reach: Tailscale is easiest, or their own domain behind a reverse proxy.
2. Get the code and work from its folder.

   ```sh
   git clone https://github.com/jonmartin-dev/amble.git amble
   cd amble
   ```

3. Settle the address with them. It becomes `AMBLE_PUBLIC_URL`, with no slash at the end. With Tailscale it's `https://<machine>.<tailnet>.ts.net`. `tailscale status` shows the machine's name, and the DNS tab of Tailscale's admin page shows the tailnet's name. MagicDNS and HTTPS certificates have to be on there, which they turn on themselves.
4. Ask whether Claude should be able to reach Amble. Yes puts the server on the internet through Tailscale Funnel, so tell them that before they answer.
5. Run the setup script without questions.

   ```sh
   deploy/setup.sh --yes --url https://server.tail1234.ts.net --assistants no
   ```

   On Windows, run `deploy\setup.cmd` in PowerShell with the same flags. `deploy/setup.sh --help` lists every flag, such as `--timezone` (this computer's by default) and `--ai-provider` with `--ai-key-file`. The first build takes a few minutes.
6. Run `deploy/setup.sh --check`. Fix every `[fix]` line it prints and check again. Don't go on until it passes and says `Reachable at` their address.
7. The script ends with a QR code and a code like `ABCD-EFGH`. On their phone they install Amble, choose Use my own server, then Scan the code. The code works once and lasts a day, and `deploy/setup.sh --admin-code` makes a new one.
8. If they want Claude, follow [docs/assistants.md](docs/assistants.md). The connector's address is `<AMBLE_PUBLIC_URL>/mcp`.

While you do it:

- Ask for one thing at a time.
- Never ask them to paste a secret (an AI key, a sign-in client's secret) into the chat. Have them save it to a file on the server themselves and pass the file's path (`--ai-key-file`, `--client-secret-file`). They can also set the AI model later in the app, under Settings, AI.
- With `--yes` the script won't wait for a `sudo` password. It stops and prints the command it needs. Give that line to the person to run, then run the script again.
- When a step happens somewhere you can't reach (Tailscale's admin page, their phone, their router), tell them exactly what to open and tap.
- The server listens on `127.0.0.1:18085` and runs as user 1000. When `data/` and `secrets/` belong to someone else, the check says so and the fix is `sudo chown -R 1000:1000 data secrets`.
- To change an answer, run the setup script again. It keeps what was set and backs up the old `.env`. Edit `.env` by hand only for settings the script has no flag for ([.env.example](.env.example) explains each one).

To keep it running, `deploy/setup.sh --update` backs up the database and updates, `docker compose logs -f amble` shows the log, and a copy of `data/` is the backup. [docs/self-hosting.md](docs/self-hosting.md#keeping-it-running) has the rest.

### The Android app from source

It needs JDK 21 and the Android SDK, which Android Studio installs. `node scripts/android.ts run` builds a debug app and installs it on the phone or emulator `adb` sees. Google Drive sync in a build of your own needs an Android OAuth client in the person's own Google Cloud project ([docs/android.md](docs/android.md#google-sign-in)). Everything else works without one, including sync with a household server.

## Working on the code

You need Node 26 or newer (the server uses the built-in `Temporal`) and the pnpm version in `package.json`'s `packageManager`.

```sh
pnpm install
cp .env.example .env    # dev sign-in is on, so no sign-in provider is needed
pnpm dev                # the app on http://127.0.0.1:5174, the server on 8787 behind it
```

`pnpm demo` runs the built app on a demo household at http://localhost:8787 instead. Run `pnpm build` after changing the app, and delete `.demo/` to start the household over, since its tasks are dated from the day it was made.

All three of these must pass before a change is done:

```sh
pnpm typecheck
pnpm test
pnpm test:wasm
```

For a change people can see, also run `node scripts/smoke.ts sam@example.com` against a fresh `pnpm demo`.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before your first change. It has the layout and the reasons behind these rules, which are the ones agents trip over most:

- Don't run a formatter. The repo has no Prettier or ESLint config, and its style is matched by hand, comments included.
- Node runs the server's `.ts` files with type stripping, so no enums, namespaces or parameter properties, and imports name their `.ts` files.
- Planning and AI features suggest and never move anything. Nothing changes until a person taps Add or Accept.
- No new notifications, badges, red overdue counts or streaks. App text is plain and calm, with no exclamation marks and no guilt.
- AI calls go through `ask()` in `server/ai/client.ts`, never a provider's SDK directly.
- Server dates use `Temporal` and the helpers in `server/lib/dates.ts`. A person's day turns over at their cutoff hour (4am by default).
- A schema change is `server/db/schema.ts`, then `pnpm db:generate`, with the new migration in `drizzle/` in the same commit. A new table with household data also goes in `server/sync/tables.ts`, or it won't sync.
- Animate only `transform` and `opacity` for anything frequent.
- Commit messages are short, lowercase and plain.
- Never commit `.env`, `secrets/`, `deploy/local.env` or `android/keystore.properties`. Git already ignores them.

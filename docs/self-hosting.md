# Running your own server

Most people don't need a server. The Android app keeps everything on the phone, keeps a household in step through Google Drive, and runs AI features with a key one person sets up for everyone. Nobody runs a server for you either: there's no Amble website or service to sign up for. Each household that wants a server runs its own, on a computer it keeps.

A server is worth it for what only a server can do:

- **Claude and ChatGPT.** The connector lets either add, plan and finish tasks for you.
- **Photos and files on tasks, shared.** Through Google Drive they stay on the device that added them.
- **The web app at your own address**, for iPhones and computers, which have no Android app.
- **Syncing without Google.** Nothing goes through Google at all.
- **The AI key kept on the server.** A household on Google Drive shares its model through the household's file, where anyone in it could read the key. On a server it stays locked on the server.

Once a household has a server, everyone uses the Android app or the web app it serves, and both sync through it.

## What you need

- **A computer that stays on**, with [Docker](https://docs.docker.com/get-docker/) and Docker Compose: a home server, a NAS or a mini PC. Amble runs on x86-64 Linux; ARM boards such as a Raspberry Pi should work too, but nobody has tried one yet. Docker Desktop on a Mac or Windows works if the computer doesn't sleep. On Windows you also need [Git for Windows](https://git-scm.com), whose Git Bash runs the setup script.
- **An address your devices can reach.** [Tailscale](https://tailscale.com) is the easiest: free for a household, and it gives the server an HTTPS address that only your devices reach. The setup script points it at the server for you. Your own domain behind a reverse proxy works too.
- **Optional: an AI provider key.** You can set it later in the app. Gemini and GLM have free tiers.

There's no sign-in to set up. Phones and computers get in with a code from one that's already in, and the setup script gives you the first. If you'd rather sign in with Google or a provider you run yourself as well, [sign-in.md](sign-in.md) has the steps.

## With an AI assistant

This guide is written so an AI assistant can take you through it. One that can run commands on the server (Claude Code, Codex, Gemini CLI) can do most of it. A chat assistant can tell you what to run and what to click. Give it this:

```text
I want to run an Amble server on this computer. Clone https://github.com/jonmartin-dev/amble if it isn't here
yet, then follow docs/self-hosting.md step by step. Ask me for the values it needs, one at a time. When a step needs me
somewhere else (Tailscale's admin page, my router, my phone), tell me exactly what to do. Never ask me to paste a
secret into the chat: have me save it to a file on the server instead. Run deploy/setup.sh --check
(deploy\setup.cmd --check on Windows) after each step, and fix whatever it reports before going on.
```

## Step by step

### 1. Get the code

```sh
git clone https://github.com/jonmartin-dev/amble.git amble
cd amble
```

Every command below runs in this folder, on the server. On Windows, run them in PowerShell and use `deploy\setup.cmd` wherever this guide says `deploy/setup.sh`: it runs the same script in Git Bash and takes the same options.

### 2. Choose the address

This is the address people's devices open: `AMBLE_PUBLIC_URL`.

- **Tailscale:** install Tailscale on the server and on your phones, and turn on MagicDNS and HTTPS certificates in its admin page (DNS). The address is `https://<the server's name>.<your tailnet>.ts.net`. `tailscale status` shows the name, and the admin page's DNS tab shows the tailnet.
- **Your own domain:** something like `https://amble.example.com`, with its DNS pointing at your home and a reverse proxy that handles HTTPS.

Amble can also run under a path, like `https://example.com/amble`, next to other things on the same address. The address is the whole thing, path included, with no slash at the end.

### 3. Run the setup script

```sh
deploy/setup.sh
```

On Windows, in PowerShell:

```powershell
deploy\setup.cmd
```

It asks for the address, your time zone, and how people get in: with codes, or with a sign-in provider as well. With a Tailscale address it also asks whether Claude and ChatGPT should be able to reach Amble, which puts the address on the internet through Tailscale Funnel. Then it writes `.env` and `secrets/`, builds and starts the server, points Tailscale at it, checks each part, and shows the code that lets you in. The first build takes a few minutes. Run it again whenever you want to change an answer; it keeps what you set before and backs up the old `.env`.

An assistant can run it without questions:

```sh
deploy/setup.sh --yes --url https://server.tail1234.ts.net --assistants yes
```

`deploy/setup.sh --help` lists every flag. On Linux the server runs as user 1000, the first account on most systems. If you're someone else, the script asks for `sudo` once to hand `data/` and `secrets/` to that user, and pointing Tailscale at the server needs `sudo` too. With `--yes` it won't wait for a password: it stops and says what to run, and you run that line yourself, then the script again.

### 4. Put the address in front of it

With a Tailscale address the script has done this already: it says `Tailscale (serve) sends … to port 18085`, or `(funnel)` when Claude and ChatGPT can reach it. The first time, Tailscale may stop to give a link that turns HTTPS on for your tailnet; open it and the script carries on. Otherwise:

- **Tailscale by hand:** `sudo tailscale serve --bg 18085`, or `funnel` instead of `serve` for Claude and ChatGPT (on Windows and Macs, without `sudo`).
- **A reverse proxy:** send the address to `http://127.0.0.1:18085`. With Caddy, which gets the HTTPS certificate itself:

  ```text
  amble.example.com {
      reverse_proxy 127.0.0.1:18085
  }
  ```

  Under a path, the proxy can pass the path on or strip it; Amble handles both.

Then run `deploy/setup.sh --check`. When it says `Reachable at` your address, this step is done. It checks from the server itself, so if a phone still can't open the address, check that the phone is on Tailscale or can reach your network. For a Tailscale address it asks Tailscale where the name is, since a server that doesn't use Tailscale's DNS would otherwise look it up on the internet, where only Funnel's ports answer.

### 5. Get in

The script ends with a QR code and a code like `ABCD-EFGH`. Install the app on your phone ([android.md](android.md)), choose **Use my own server**, then **Scan the code**, and scan it from the screen. You're in as the admin, and what's on the phone comes along. On an iPhone or a computer, open the link the script printed instead.

That code works once and lasts a day. `deploy/setup.sh --admin-code` makes another any time, which is also how you get back in if every phone that was in is lost.

### 6. Add everyone else

On a phone or computer that's already in, open Settings, Your server, **Add a phone or computer**:

- **A code for me** brings in another of your own devices, and signs you in on the server's page in a browser.
- **For someone new** brings in someone new to the household. Only an admin can make one.

Each code works once and lasts 10 minutes. On the new phone, choose **Use my own server** and scan it. An iPhone's camera opens Amble in the browser from it; in Safari, Share, Add to Home Screen makes it an app. On a computer, open your address and type the code.

A household already keeping Amble in Google Drive moves over the same way: the first phone to join the server brings the household with it. Everyone else is offered the move in Settings, Sync and backup with one tap, and until they've all moved, that first phone keeps the Drive file in step for them ([google-drive.md](google-drive.md#a-server-in-the-household)).

### 7. Extras

- **AI:** in the app, Settings, AI, Your household's model. Pick a provider, paste its key and set a monthly cap; everyone's devices use it.
- **Claude and ChatGPT:** these need the address reachable from the internet, not just your tailnet. With Tailscale, run `deploy/setup.sh --assistants yes`; with your own domain it already is. Then follow [assistants.md](assistants.md). When the assistant asks you to sign in, use a code for you from Add a phone or computer.
- **Signing in with Google or your own provider**, as well as codes: [sign-in.md](sign-in.md).

## Keeping it running

| To | Run |
|---|---|
| Check everything | `deploy/setup.sh --check` |
| Update to the latest version | `deploy/setup.sh --update` (it backs up the database first) |
| Get a new admin code | `deploy/setup.sh --admin-code` |
| Read the log | `docker compose logs -f amble` |
| Stop or start it | `docker compose stop` / `docker compose start` |
| Back up | Copy `data/`. `docker compose exec amble node server/backup.ts` writes a consistent copy of the database to `data/snapshots/almanac-latest.db` first |

The server restarts by itself after a reboot, as long as Docker starts with the computer.

## When something's wrong

Start with `deploy/setup.sh --check`. Each `[fix]` line says what to change. The usual ones:

| It says | What to do |
|---|---|
| Docker isn't running, or this user can't use it | Start Docker. On Linux, add yourself to the `docker` group and sign in again. |
| Nothing answers on 127.0.0.1 | `docker compose logs amble` shows why. A missing setting names itself there. |
| Not reachable at your address | Step 4: the proxy or Tailscale isn't sending the address to the server's port. |
| That code doesn't work | Codes work once and run out (10 minutes, or a day for the setup script's). Make a new one. |
| Too many codes that didn't work | Wait a few minutes. A run of wrong codes from one place is turned away for a while. |
| data/ and secrets/ have to belong to the container's user | `sudo chown -R 1000:1000 data secrets` |

With a sign-in provider, [sign-in.md](sign-in.md#when-sign-in-fails) explains what each sign-in message means.

## Without the script

The setup script writes two things, starts Docker and shows a code. By hand, that's:

```sh
cp .env.example .env    # set AMBLE_PUBLIC_URL, AMBLE_TIMEZONE, and AMBLE_DEV_LOGIN=0
mkdir -p data secrets
openssl rand -base64 32 > secrets/amble_secret     # what the server locks its keys under
printf '%s' 'your-ai-key' > secrets/ai_api_key     # optional: or set the model later in the app, Settings, AI
docker compose up -d --build
docker compose exec amble node server/pair.ts admin   # the first admin's code
```

`.env.example` explains every setting. A few worth knowing:

- `AMBLE_PORT` moves the server off `127.0.0.1:18085`.
- `AMBLE_PUBLIC_URL` can include a path, like `https://example.com/amble`; the proxy may pass the path on or strip it.
- `AMBLE_PRIVACY_CONTACT` puts a contact on the app's `/privacy` page.
- `OIDC_CLIENT_ID`, with its secret in `secrets/oidc_client_secret`, adds a sign-in provider ([sign-in.md](sign-in.md)).
- `AMBLE_GOOGLE_API_KEY` turns on Google's file picker for Google Drive in a browser that opened the web app from the server; the server's address also has to be in your Google Cloud setup ([google-drive.md](google-drive.md#google-cloud-setup)).
- `AMBLE_APP_ORIGINS` lets a copy of the web app hosted somewhere else sync with the server.

## Just the web app, with no server

The web app also runs as plain static files, with everything kept in the browser and sync through Google Drive:

```sh
AMBLE_BASE=/ pnpm build    # static files in dist/web
```

Host `dist/web` anywhere that serves `index.html` for paths it doesn't have. `AMBLE_BASE` is the path it's served under, with slashes at both ends. [google-drive.md](google-drive.md#building-the-app-with-google-settings) has the Google settings to build it with, so Drive sync works there too.

# Running your own server

Most people don't need a server. The Android app keeps everything on the phone, keeps a household in step through Google Drive, and runs AI features with a key of your own. Nobody runs a server for you either: there's no Amble website or service to sign up for. Each household that wants a server runs its own, on a computer it keeps.

A server is worth it for what only a server can do:

- **One AI model for the household.** The key stays on the server, and everyone's devices use it, with one monthly cap.
- **Photos and files on tasks, shared.** Through Google Drive they stay on the device that added them.
- **Claude and ChatGPT.** The connector lets either add, plan and finish tasks for you.
- **The web app at your own address**, for iPhones and computers, which have no Android app.
- **Syncing without Google**, with a sign-in provider you run yourself.

Once a household has a server, everyone uses the Android app or the web app it serves, and both sync through it.

## What you need

- **A computer that stays on**, with [Docker](https://docs.docker.com/get-docker/) and Docker Compose: a home server, a NAS or a mini PC. Amble runs on x86-64 Linux; ARM boards such as a Raspberry Pi should work too, but nobody has tried one yet. Docker Desktop on a Mac or Windows works if the computer doesn't sleep.
- **An address your devices can reach.** [Tailscale](https://tailscale.com) is the easiest: free for a household, and it gives the server an HTTPS address that only your devices reach. Your own domain behind a reverse proxy works too.
- **A sign-in provider.** Google is the default and free: you make a sign-in client in Google Cloud, which takes about five minutes. Any OpenID Connect provider you run yourself works instead ([sign-in.md](sign-in.md)).
- **Optional: an AI provider key.** You can set it later in the app. Gemini and GLM have free tiers.

## With an AI assistant

This guide is written so an AI assistant can take you through it. One that can run commands on the server (Claude Code, Codex, Gemini CLI) can do most of it. A chat assistant can tell you what to run and what to click. Give it this:

```text
I want to run an Amble server on this computer. Clone https://github.com/jonmartin-dev/amble if it isn't here
yet, then follow docs/self-hosting.md step by step. Ask me for the values it needs, one at a time. When a step needs me in a
browser (Google Cloud, Tailscale's admin page, my router), tell me exactly what to click and what to copy
back. Never ask me to paste a secret into the chat: have me save it to a file on the server instead.
Run deploy/setup.sh --check after each step, and fix whatever it reports before going on.
```

## Step by step

### 1. Get the code

```sh
git clone https://github.com/jonmartin-dev/amble.git amble
cd amble
```

Every command below runs in this folder, on the server.

### 2. Choose the address

This is the address people's devices open: `AMBLE_PUBLIC_URL`. Pick it before making the sign-in client, because the client needs it.

- **Tailscale:** install Tailscale on the server and on your phones, and turn on MagicDNS and HTTPS certificates in its admin page (DNS). The address is `https://<the server's name>.<your tailnet>.ts.net`. `tailscale status` shows the name, and the admin page's DNS tab shows the tailnet.
- **Your own domain:** something like `https://amble.example.com`, with its DNS pointing at your home and a reverse proxy that handles HTTPS.

Amble can also run under a path, like `https://example.com/amble`, next to other things on the same address. The address is the whole thing, path included, with no slash at the end.

### 3. Make a sign-in client

For Google:

1. Open [Google Cloud](https://console.cloud.google.com/) and create a project (call it Amble).
2. Open **Google Auth Platform** (in older consoles: APIs & Services, OAuth consent screen) and choose Get started. Name the app Amble, give your email for support and contact, and choose **External** for the audience.
3. Under **Audience**, choose **Publish app**, so the status says In production. In testing mode, Google ends the server's Drive connection after 7 days. Google warns once, when someone signs in, that the app isn't verified; that's expected for a household's own server.
4. Under **Clients**, create a client of type **Web application**. Under Authorized redirect URIs, add your address followed by `/auth/callback`, for example `https://server.tail1234.ts.net/auth/callback`.
5. Copy the **client ID**. Save the **client secret** to a file on the server, for example `~/amble-client-secret`. Google shows the secret only once.

For another provider, [sign-in.md](sign-in.md) has the steps. You'll also need its issuer address.

### 4. Run the setup script

```sh
deploy/setup.sh
```

It asks for the address, your email (you'll be the admin), anyone else who may sign in, your time zone, and the sign-in client's ID and secret. Then it writes `.env` and `secrets/`, builds and starts the server, and checks each part. The first build takes a few minutes. Run it again whenever you want to change an answer; it keeps what you set before and backs up the old `.env`.

An assistant can run it without questions:

```sh
deploy/setup.sh --yes --url https://server.tail1234.ts.net --admin you@example.com \
  --allow partner@example.com --client-id 1234-abc.apps.googleusercontent.com \
  --client-secret-file ~/amble-client-secret
```

`deploy/setup.sh --help` lists every flag, including `--issuer` and `--provider-name` for providers other than Google. Once the secret is in `secrets/oidc_client_secret`, you can delete the file you saved it in.

The server now answers on `127.0.0.1:18085` on the server itself (choose another port with `--port`). Only the server can reach that address until the next step.

### 5. Put the address in front of it

- **Tailscale:** `sudo tailscale serve --bg 18085`. Your devices on Tailscale can now open the address. The first time, the command may give you a link to turn HTTPS on.
- **A reverse proxy:** send the address to `http://127.0.0.1:18085`. With Caddy, which gets the HTTPS certificate itself:

  ```text
  amble.example.com {
      reverse_proxy 127.0.0.1:18085
  }
  ```

  Under a path, the proxy can pass the path on or strip it; Amble handles both.

Then run `deploy/setup.sh --check`. When it says `Reachable at` your address and `Google accepts sign-ins`, this step is done. It checks from the server itself, so if a phone still can't open the address, check that the phone is on Tailscale or can reach your network.

### 6. Sign in

Open `<your address>/server` in a browser and sign in with the admin email. That page is the server's own: the code to add phones, connected assistants, the AI model and the Google Drive bridge. The app has the same things under Settings, Your server.

### 7. Add your devices

- **Android:** install the app ([android.md](android.md)) and choose **Use my own server**, then **Scan the code**. The code is on the server's page from step 6, or in Settings, Your server on a device that's already set up. Sign in, and the phone joins the household.
- **iPhone or a computer:** scan the same code with the camera, or open your address in the browser, and choose **Join through** your server. In Safari, Share, Add to Home Screen makes it an app.
- **Someone else in the household:** add them in People (or put their email in `--allow`). Each person signs in with their own account.

### 8. Extras

- **AI:** in the app, Settings, AI, Your household's model. Pick a provider, paste its key and set a monthly cap; everyone's devices use it.
- **Claude and ChatGPT:** these need the address reachable from the internet, not just your tailnet: `sudo tailscale funnel --bg 18085` instead of `serve`, or a public domain. Then follow [Use it from Claude or ChatGPT](../README.md#use-it-from-claude-or-chatgpt).
- **A household already in Google Drive:** the server joins the Drive file, and each device then offers a move to the server ([google-drive.md](google-drive.md#a-server-in-the-household)).

## Keeping it running

| To | Run |
|---|---|
| Check everything | `deploy/setup.sh --check` |
| Update to the latest version | `deploy/setup.sh --update` (it backs up the database first) |
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
| Not reachable at your address | Step 5: the proxy or `tailscale serve` isn't sending the address to the server's port. |
| Google doesn't have …/auth/callback as a redirect URI | In Google Cloud, Clients, add it exactly, with no slash at the end. |
| Google doesn't know the client ID | Copy the ID again; a space or a missing piece is enough to break it. |
| data/ and secrets/ have to belong to the container's user | `sudo chown -R 1000:1000 data secrets` |

If sign-in itself fails in the browser, [sign-in.md](sign-in.md#when-sign-in-fails) explains each message.

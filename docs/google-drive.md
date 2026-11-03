# Syncing through Google Drive

Amble runs on the device: in a browser or the Android app, its API runs in a worker on SQLite kept on that device. There's no account, and on its own nothing leaves the device.

Google Drive keeps a household's copies in step with nobody hosting anything. Each person's Amble keeps a full copy, and one file in Drive holds the household's state: a device takes in what changed there, merges it field by field (the later change to each field wins), and writes back what the file lacks. A household can also skip Drive and sync through its own server instead: everyone chooses Use my own server on first open, and the server shares photos and files on tasks too. A household that started in Drive moves onto a server from a phone, which keeps the file in step for the others until they've moved too ([below](#a-server-in-the-household)). Once a household has a server, the app offers the server rather than Drive.

## How it fits together

| | Just you | A household |
|---|---|---|
| Where the copy lives | Amble's hidden folder in your Drive (`drive.appdata`), which only Amble can open | A file named like "Sam's Amble household" in the Drive of whoever made the household, shared with the others |
| Your other devices | Choose "I already use Amble" on first open and sign in with the same Google account | The same |
| Adding someone | | Make the household and add them in Sync and backup. Google emails them a link; in Amble they choose "Join a household" and pick the file once in Google's picker |
| A server | | The first phone to join it brings the household; the others move with a tap ([below](#a-server-in-the-household)) |

Amble asks Google only for `drive.appdata` and `drive.file`: its hidden folder, and files it made or that someone picked for it. Google counts both as non-sensitive, so the consent screen needs no verification for them. The cost of that narrow access is why joining a household takes the picker: with `drive.file`, Amble can't open a file someone shared until they pick it.

What to know before relying on it:

- **A browser renews its Drive access by itself.** Google gives a web page a token that lasts about an hour. With a [token endpoint](#keeping-a-browser-signed-in), signing in brings back a refresh token too, and the app renews in place. Without one, it takes a quick trip to Google that shows nothing (`prompt=none`) when Amble opens, when its tab is in the background with changes to send, or when the page has sat untouched for a couple of minutes. Only someone signed out of Google, or who took Amble's access away, sees "Sync paused" with Continue. The Android app and the server renew on their own.
- **Photos and files on tasks stay on the devices of whoever added them.** The same Drive rule keeps other people's Amble from opening files someone else uploaded. Google's wider `drive` permission would let it, but needs Google's paid security review; a household server shares them instead.
- **Private lists are hidden in the app, not in the file.** Everyone in a household has the whole household file in their Drive, and could read it outside Amble.
- **Everyone needs the same version.** A copy written by a newer Amble (a newer database migration) isn't merged by an older one; the older one says to update.
- **The same person or thing made twice becomes one.** If two devices each add the same email, or the server and a household each had their own row for you, every copy keeps the row with the smaller id and moves everything that pointed at the other onto it.

## Building the app with Google settings

**Served by an Amble server,** the app gets its Google settings from the server: its Google client, `AMBLE_GOOGLE_API_KEY` for the picker, and its own `/google/token`. There's nothing to build in.

**On a static host,** build them in:

```sh
VITE_GOOGLE_CLIENT_ID=… VITE_GOOGLE_API_KEY=… VITE_GOOGLE_APP_ID=… AMBLE_BASE=/ pnpm build
```

That writes static files to `dist/web`. Host them anywhere that serves `index.html` for paths it doesn't have (Cloudflare Pages does when there's no `404.html`). `AMBLE_BASE` is the path it's served under, with slashes at both ends. Without the `VITE_GOOGLE_*` settings the app still works; it just can't sync through Drive. `pnpm dev` serves it on http://127.0.0.1:5174 (and http://localhost:5174, which the browser treats as another site: handy for trying sync between two "devices" in one browser), with those settings from `.env`.

## Keeping a browser signed in

Google hands a web page a refresh token only through the authorization code flow, and for a "Web application" client its token calls want the client secret, which a page can't keep. A small token endpoint adds the secret to those two calls (trading the code, and refreshing) for the app's own addresses. It stores and logs nothing; the browser keeps its refresh token. An app the server serves uses the server's. A static build takes its address:

```sh
VITE_GOOGLE_TOKEN_URL=https://example.com/amble/google/token … pnpm build
```

- **On an Amble server** it's already there, at `<AMBLE_PUBLIC_URL>/google/token`, whenever the server has a Google client with its secret. It answers pages on the server's own address; list an app served from anywhere else in `AMBLE_APP_ORIGINS`.
- **With no server**, deploy `deploy/google-token-worker` to Cloudflare Workers (free): set `GOOGLE_CLIENT_ID` and `ALLOWED_ORIGINS` in its `wrangler.toml`, run `npx wrangler secret put GOOGLE_CLIENT_SECRET`, then `npx wrangler deploy`, and use `https://<the worker's address>/google/token`.

The Google client needs nothing new: the code flow comes back to the same `/google-return` address. Stopping sync on a device forgets its refresh token rather than revoking it, since Google would take the whole grant for that client, an Amble server's included.

## Google Cloud setup

In the Google Cloud project with your OAuth client (the one Amble's server signs in with, if you have one):

1. **Turn on the Google Drive API and the Google Picker API** (APIs & Services, Library).
2. **On the OAuth client** (Google Auth Platform, Clients, your "Web application" client):
   - Authorized JavaScript origins: each address the app is served from, like `https://amble.example.com` (and `http://127.0.0.1:5174` for development). An app served by an Amble server is at the server's address.
   - Authorized redirect URIs: each of those addresses followed by `/google-return`, like `https://amble.example.com/google-return` or `https://example.com/amble/google-return`. The console silently drops an address that's only the site with a slash, so it has to have that path. The server's own `<AMBLE_PUBLIC_URL>/auth/callback` stays as it is.
3. **Data access:** add `https://www.googleapis.com/auth/drive.appdata` and `https://www.googleapis.com/auth/drive.file`. Both are non-sensitive.
4. **An API key for the picker** (APIs & Services, Credentials, Create credentials, API key): restrict it to the Google Picker API, and to websites matching the app's addresses (`https://amble.example.com/*`). An Amble server hands it to the app it serves as `AMBLE_GOOGLE_API_KEY`.
5. The **app id** is the project number, the digits before the dash in the client id.

For a static build, `VITE_GOOGLE_CLIENT_ID` is the client id, `VITE_GOOGLE_API_KEY` the key and `VITE_GOOGLE_APP_ID` the project number. None of them are secrets: they end up in the app's code, and Google ties each to the addresses you listed.

## A server in the household

A household on Drive moves to its own server from a phone, with nothing to set up on the server for Google:

1. Someone runs the server ([self-hosting.md](self-hosting.md)) and gets in from their phone with the setup script's code, or a code from someone already there. That phone brings the whole household with it.
2. From then on that phone keeps the household's file in step with the server too, for everyone still on Drive. It notes the server on the file (public Drive properties: `ambleServer`, the address, and `ambleJoin`, an invite to it that lasts 30 days), so each device still on Drive offers a move in Settings, Sync and backup. One tap, with no code: the device joins the server as its person, with what it had.
3. Once everyone has moved, that phone's Sync and backup has Stop keeping Google Drive in step. The invite comes off the file and stops working, and the file stays in Drive.

Only people the household file is shared with can read its properties, the same people who can read the household in it. An admin's phone puts the invite there; a phone that isn't an admin's keeps the file in step without one, and the others each need a code instead.

A server with Google as its sign-in provider can keep the file in step itself, instead of a phone. Its sign-in client works for Drive too: turn on the Drive API (step 1) and add the scopes (step 3). With another sign-in provider, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to a Google "Web application" client with the redirect URI `<AMBLE_PUBLIC_URL>/auth/callback`. Then an admin opens the server's page (`<AMBLE_PUBLIC_URL>/server`) and chooses Connect Google Drive. Google asks once; the server keeps a refresh token, sealed. It lists the household files that Google account can open: join the household's. The server syncs every minute and a few seconds after each change, notes its address on the file, and devices still on Drive are offered the move. Once every device has moved, stop the server's Drive sync on its page.

A device that started on its own folds its starter groups into the household's when it joins, and takes over the household's row for its person.

## When something goes wrong

- **"redirect_uri_mismatch" from Google:** the redirect URI in step 2 doesn't match the app's address exactly, including `http` or `https`, the port and the `/google-return` path. Changes in the console can take a few minutes to apply.
- **The picker doesn't list the household file:** it shows files of the household's type, or gzipped files with "household" in the name. Check it was shared with the account you're picking with, and look under "Shared with me".
- **"Google needs you to sign in again":** the token ran out or someone took Amble's access away at myaccount.google.com/connections. Tap Continue or Sync now.
- **The server's sync says to connect again:** the refresh token was revoked, or the server's secret changed (which makes sealed tokens unreadable). Connect Google Drive again.

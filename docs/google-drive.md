# Amble with no server, and syncing through Google Drive

Amble comes two ways from the same code:

- **On the device.** A static web app (or, later, the Android app) runs Amble's API inside the browser, on SQLite saved in the browser's own storage. There's no account and no server: everything stays on that device.
- **On a server.** The Docker container, which signs people in and is what Claude and ChatGPT connect to.

Both can keep a household in step through Google Drive. Each person's Amble keeps a full copy, and one file in Drive holds the household's state: a device or the server takes in what changed there, merges it field by field (the later change to each field wins), and writes back what the file lacks. Nobody needs to host anything for that. A server is only needed for the assistant connector, and for work while every device is closed (size guesses, the morning's wording, reminders as push notifications).

## How it fits together

| | Just you | A household |
|---|---|---|
| Where the copy lives | Amble's hidden folder in your Drive (`drive.appdata`), which only Amble can open | A file named like "Sam's Amble household" in the Drive of whoever made the household, shared with the others |
| Your other devices | Choose "I already use Amble" on first open and sign in with the same Google account | The same |
| Adding someone | | Make the household and add them in Sync and backup. Google emails them a link; in Amble they choose "Join a household" and pick the file once in Google's picker |
| A server | | An admin connects it in Settings, Sync, and joins the household file, or starts one from the server's data |

Amble asks Google only for `drive.appdata` and `drive.file`: its hidden folder, and files it made or that someone picked for it. Google counts both as non-sensitive, so the consent screen needs no verification for them. The cost of that narrow access is why joining a household takes the picker: with `drive.file`, Amble can't open a file someone shared until they pick it.

What to know before relying on it:

- **A browser renews its Drive access by itself.** Google gives a web page a token that lasts about an hour. With a [token endpoint](#keeping-a-browser-signed-in), signing in brings back a refresh token too, and the app renews in place. Without one, it takes a quick trip to Google that shows nothing (`prompt=none`) when Amble opens, when its tab is in the background with changes to send, or when the page has sat untouched for a couple of minutes. Only someone signed out of Google, or who took Amble's access away, sees "Sync paused" with Continue. The Android app and the server renew on their own.
- **Photos and files on tasks stay on the devices of whoever added them.** The same Drive rule keeps other people's Amble from opening files someone else uploaded.
- **Private lists are hidden in the app, not in the file.** Everyone in a household has the whole household file in their Drive, and could read it outside Amble.
- **Everyone needs the same version.** A copy written by a newer Amble (a newer database migration) isn't merged by an older one; the older one says to update.
- **The same person or thing made twice becomes one.** If two devices each add the same email, or the server and a household each had their own row for you, every copy keeps the row with the smaller id and moves everything that pointed at the other onto it.

## Building the device app

```sh
VITE_GOOGLE_CLIENT_ID=… VITE_GOOGLE_API_KEY=… VITE_GOOGLE_APP_ID=… AMBLE_BASE=/ pnpm build:device
```

That writes static files to `dist/device`. Host them anywhere that serves `index.html` for paths it doesn't have (Cloudflare Pages does when there's no `404.html`). `AMBLE_BASE` is the path it's served under, with slashes at both ends, `/` by default. Without the `VITE_GOOGLE_*` settings the app still works; it just can't sync. `pnpm dev:device` serves it on http://localhost:5174 (and http://127.0.0.1:5174, which the browser treats as another site: handy for trying sync between two "devices" in one browser). In development those settings come from `.env`.

## Keeping a browser signed in

Google hands a web page a refresh token only through the authorization code flow, and for a "Web application" client its token calls want the client secret, which a page can't keep. A small token endpoint adds the secret to those two calls (trading the code, and refreshing) for the app's own addresses. It stores and logs nothing; the browser keeps its refresh token. Build the app with its address:

```sh
VITE_GOOGLE_TOKEN_URL=https://example.com/amble/google/token … pnpm build:device
```

- **On an Amble server** it's already there, at `<AMBLE_PUBLIC_URL>/google/token`, whenever the server has a Google client with its secret. It answers pages on the server's own address; list a device app served from anywhere else in `AMBLE_GOOGLE_TOKEN_ORIGINS`.
- **With no server**, deploy `deploy/google-token-worker` to Cloudflare Workers (free): set `GOOGLE_CLIENT_ID` and `ALLOWED_ORIGINS` in its `wrangler.toml`, run `npx wrangler secret put GOOGLE_CLIENT_SECRET`, then `npx wrangler deploy`, and use `https://<the worker's address>/google/token`.

The Google client needs nothing new: the code flow comes back to the same `/google-return` address. Stopping sync on a device forgets its refresh token rather than revoking it, since Google would take the whole grant for that client, an Amble server's included.

## Google Cloud setup

In the Google Cloud project with your OAuth client (the one Amble's server signs in with, if you have one):

1. **Turn on the Google Drive API and the Google Picker API** (APIs & Services, Library).
2. **On the OAuth client** (Google Auth Platform, Clients, your "Web application" client):
   - Authorized JavaScript origins: the device app's address, like `https://amble.example.com` (and `http://localhost:5174` for development).
   - Authorized redirect URIs: the device app's address followed by `/google-return`, like `https://amble.example.com/google-return`. The console silently drops an address that's only the site with a slash, so it has to have that path. The server's own `<AMBLE_PUBLIC_URL>/auth/callback` stays as it is.
3. **Data access:** add `https://www.googleapis.com/auth/drive.appdata` and `https://www.googleapis.com/auth/drive.file`. Both are non-sensitive.
4. **An API key for the picker** (APIs & Services, Credentials, Create credentials, API key): restrict it to the Google Picker API, and to websites matching the device app's address (`https://amble.example.com/*`).
5. The **app id** is the project number, the digits before the dash in the client id.

`VITE_GOOGLE_CLIENT_ID` is the client id, `VITE_GOOGLE_API_KEY` the key and `VITE_GOOGLE_APP_ID` the project number. None of them are secrets: they end up in the app's code, and Google ties each to the addresses you listed.

## A server in the household

The server uses its sign-in client for Drive too, so with Google sign-in there's nothing more to set: turn on the Drive API (step 1) and add the scopes (step 3). With another sign-in provider, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as for Google Calendar.

Then an admin opens Settings, Sync with Google Drive, and chooses Connect Google Drive. Google asks once; the server keeps a refresh token, sealed under the client secret like calendar tokens. It lists the household files that Google account can open: join one, or make a household from the server's own data. The server syncs every minute and a few seconds after each change, from the app, from Claude or ChatGPT through the connector, or from its background jobs.

To move a household that already runs on a server onto Drive: connect the server and choose "Make a household from this server", share the file from a device signed in with the same Google account (Sync and backup, Add someone), and have each person join from their own device. A device that started on its own folds its starter groups into the household's when it joins, and takes over the household's row for its person.

## When something goes wrong

- **"redirect_uri_mismatch" from Google:** the redirect URI in step 2 doesn't match the app's address exactly, including `http` or `https`, the port and the `/google-return` path. Changes in the console can take a few minutes to apply.
- **The picker doesn't list the household file:** it shows files of the household's type, or gzipped files with "household" in the name. Check it was shared with the account you're picking with, and look under "Shared with me".
- **"Google needs you to sign in again":** the token ran out or someone took Amble's access away at myaccount.google.com/connections. Tap Continue or Sync now.
- **The server's sync says to connect again:** the refresh token was revoked, or the server's client secret changed (which makes sealed tokens unreadable). Connect Google Drive again.

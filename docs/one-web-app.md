# One web app, with a server only for extras

A plan, written 2026-10-15. None of it is built yet.

Amble's web page comes two ways today, from the same React code:

- **The server's page.** The Docker container serves it, signs people in, and keeps the household in the server's database.
- **The device build** (`pnpm build:device`). The same app with its API running in a worker on SQLite in the browser, synced through a Google Drive file. The Android app is this build in Capacitor.

Since the household moved into Drive, the server is just another copy that syncs with the file. This plan makes the device build the only web app, on phones and computers alike, and turns the server into an optional add-on with no app pages of its own.

## What only a server can do

| What | Why it takes a server | Without one |
|---|---|---|
| Claude and ChatGPT through the connector | An assistant has to reach Amble over the internet, and sign someone in through OAuth | No assistant |
| Reminders while the browser is closed | Web push is sent by a server holding the VAPID key | A browser shows reminders only while Amble is open. The Android app is unaffected: it hands reminders to Android |
| Work while every device is closed | Size guesses, the morning's wording and reminders run as background jobs | They run whenever Amble is open instead |
| Calendar load | Reading Google Calendar needs a client secret and a refresh token, which only the server has | No calendar in the day's load (see [Calendar](#calendar)) |
| One AI key for the household, with a monthly cap | The server holds the key | Each device sets up its own |
| Files shared between people | Files uploaded through the server's page are stored on the server | Files stay on the device that added them, as they already do with Drive |
| Drive access that renews quietly in a browser | A refresh token takes Google's client secret, which a static page can't hold | Today a browser asks for a tap about once an hour (the Android app renews on its own). See [Keeping a browser signed in to Drive](#keeping-a-browser-signed-in-to-drive): this has to be fixed before the web app is the only one |
| A household with no Google at all | Sign-in with any OpenID provider, data on the server | Everything syncs through Google Drive |

The connector stands out. The others either have a device-side substitute or affect only people using a browser on a computer.

## The proposal

- **The web app is the device build, everywhere.** The page people open is the same app as the Android one: data on the device, offline from the start, no account, synced through Drive.
- **The server is an add-on.** It syncs with the household file like any device and adds the connector, background work and, later, the extras below. It serves no app pages. What it shows is a few plain pages: sign-in, the one-tap consent when connecting an assistant, the list of connected assistants, connecting the server to Drive, and its privacy page.
- **Same address, when both are hosted together.** The app keeps the address people installed (for example `/amble/`), and the server's routes sit beside it: `/auth/*`, `/oauth/*`, `/mcp`, `/.well-known/*`, `/healthz` and its pages. The consent page moves from `/connect/<id>`, which the app also uses, to `/oauth/consent/<id>`.

Extras the server could add later, for people who run one:

- **Push for browsers.** A browser subscribes with the server's VAPID key and registers once after signing in to the server (same origin, so the session cookie just works). The server already knows every reminder's time through sync.
- **Sync without Google.** A state-file endpoint on the server, shaped like the Drive calls in `server/sync/drive.ts` (`server/sync/fake-drive.ts` shows how little that is), would let devices sync to the server instead of Drive. This is what keeps households that avoid Google working; see [Households without Google](#households-without-google).

## What a browser user gains and loses

Gains: one app that works the same on a phone and a computer, works offline, needs no account or server, and keeps the data on the device and in their own Drive.

Losses, against the server's page today: reminders only while Amble is open, no calendar load until devices read calendars, no shared files, and no household-wide AI key. Each loss comes back for people who also run a server, through the extras above.

## Keeping a browser signed in to Drive

Today the web app gets Drive access through Google's redirect sign-in (`response_type=token` in `web/src/lib/google.ts`). The token lasts an hour and comes with no refresh token, so when it runs out the app shows "Sync paused" and waits for a tap. That's not acceptable for an app meant to sit open on a computer, so it gets fixed in two steps, before the web app replaces the server's page.

1. **Renew without asking (no server).** When the token runs out, send the page back through the same sign-in with `prompt=none` and `login_hint` set to the person's address. Google's documentation describes `prompt=none` as "Don't display any authentication or consent screens": while the person is signed in to Google and has already allowed Amble, it comes straight back with a new token. The bounce reloads the page, so it happens when Amble opens and when the tab is in the background, never under someone's hands. Only a signed-out browser or a revoked grant falls back to the Continue button.
2. **Renew in place (a tiny token endpoint).** Google's recommended flow for single-page apps is the authorization code flow with PKCE, which gives a refresh token. For a "Web application" client, Google's token endpoint wants the client secret for that, including on every refresh. So a small endpoint holds the secret and adds it to the two calls, sign-in and refresh, and nothing else. It stores nothing; the browser keeps its own refresh token. For people with an Amble server it's a route on the server. For the public web app it's a free Cloudflare Worker (or a Pages Function) beside the static files. Sync then keeps going in the background with no reloads at all.

The first step is a day's work and fixes most of it. The second retires the implicit flow, which Google describes as considered insecure for single-page apps.

## Calendar

Calendar events don't sync through the household file (each copy reads its own calendars), so today calendar load reaches only people on the server's page. Two ways to bring it to every device:

- **Each device reads its own calendar.** The Android app can ask for `calendar.readonly` through Android's Google sign-in and renew it silently; a browser renews it the same way as Drive access ([above](#keeping-a-browser-signed-in-to-drive)). `calendar.readonly` is a sensitive scope, so Amble's own Google project would need Google's verification before the public could use it.
- **The server shares busy minutes, not events.** The server already reads calendars. It could write each person's busy minutes per day into a synced table: no titles, so the household file stays as private as it is. This works only for households with a server.

Settle this before the server's page goes, since it's the last feature computers would visibly lose.

## Hosting the web app

| Where | Notes |
|---|---|
| On the server, beside its routes | Simplest for anyone running a server: one address for the app and the connector |
| Cloudflare Pages | Free, deploys from a private repository, and fine as the public address for people without a server |
| GitHub Pages | Free only for public repositories |

Each address the app is served from needs, in the Google Cloud project ([details](google-drive.md#google-cloud-setup)): the origin under Authorized JavaScript origins, `<address>/google-return` under redirect URIs, and the address on the Picker API key's website list. For people outside the project's test users, the consent screen has to be in production. Drive's two scopes are non-sensitive, so that needs no verification.

## What code goes

- **Web:** the sign-in page, the server half of every page that has one (sync, privacy, settings, people, notifications, files), and the server's push setup. The outbox stays at first, since the device build's changes go through it too, but its sending from the service worker and its guards against stale offline writes exist for the server and can be trimmed later. The `onDevice` checks (33 of them, in 13 files) collapse into one path.
- **Server:** it stops serving `dist/web` and stops exposing the app's API to browsers. `server/api.ts` stays: the device worker runs it through `server/local.ts`. The consent and connections pages, Drive setup and privacy become small server-rendered pages; `server/connector.ts` already renders its error page that way.
- **Tests and scripts:** `scripts/offline.ts`, which checks the server's page offline, goes; `server/offline.test.ts` goes with the server's side of the outbox once that's trimmed. `scripts/smoke.ts` and `scripts/screens.ts` move to the device build (`pnpm dev:device`). The API tests stay, since they test the shared API.
- **Docs:** the README, the introduction to [google-drive.md](google-drive.md), [sign-in.md](sign-in.md) (sign-in becomes something only the server does, for the connector and its own setup) and [android.md](android.md).

Roughly 1,500 to 2,500 lines out and 400 in, mostly deletions. A few focused days, in the order below.

## Moving an existing server household

- **Already syncing through Drive:** each person opens the web app, chooses "I already use Amble" and joins the household. The server keeps syncing as before.
- **Only on the server:** connect the server to Drive (Settings, Sync, "Make a household from this server"), share the file, and have each person join. Without Google, this waits for sync to the server.
- **Files on tasks:** whatever was uploaded through the server's page stays on the server. Offer a way to download them before the page goes.
- **Sessions and push registrations:** dropped. People turn reminders on again on each device.

## Households without Google

Today a household can run entirely on a self-hosted server with another sign-in provider (Authelia, Keycloak and others; see [sign-in.md](sign-in.md)) and never touch Google. Dropping the server's page takes their app away unless devices can sync to the server itself. So decide one of:

- **Support it** by building sync to the server (the state-file endpoint above), before the server's page goes.
- **Drop it**, say so in the README, and keep Google Drive as the only way to sync.

## Risks

- **Quiet renewal depends on Google's session.** Someone signed out of Google in that browser, or who removed Amble's access, still gets the Continue button. That's the right outcome, and rare.
- **The token endpoint holds a secret.** It should answer only Amble's own origins, send nothing but Google's two token calls, and log nothing.
- **iPhones** get the web app only. Safari can clear a site's storage after 7 days without a visit unless it was added to the home screen, and reminders show only while Amble is open. The real answer is an iOS build of the Capacitor app, which needs a Mac and an Apple developer account.
- **The connector's reminder note is wrong today.** When an assistant sets a reminder, `set_reminder` in `server/mcp/server.ts` warns that the person "hasn't turned on notifications on any device yet" if the server has no push registration for them. Someone who uses only the Android app does get the reminder, since it syncs to the phone. Fix it first; it stands on its own.
- **One more move for installed web apps.** The device build's service worker replaces the server build's at the same address, and the app starts empty until the person joins the household again.

## Recommendation and order of work

Do it, in this order, with the week in step 3 as the point to decide:

1. Fix the connector's reminder note.
2. Make a browser renew Drive access on its own: the `prompt=none` bounce first, then the token endpoint.
3. Host the device build beside the server's page (at `/amble/app/`, say) and use it on a computer for a week.
4. Settle calendar: devices read their own, or the server shares busy minutes.
5. Decide on households without Google.
6. Point the app's address at the device build, turn the server's remaining pages into plain pages, and delete the server's app code.
7. Update the docs.

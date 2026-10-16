# One web app, with a server only for extras

A plan, written and carried out on 2026-10-15. Every step in the [order below](#recommendation-and-order-of-work) is done: the web app is the device app everywhere, an Amble server serves it beside a few plain pages of its own, devices can sync with the server itself instead of Drive, and calendars are read on the phone. The rest of this page is the plan as written, kept for the reasoning; where it and the code differ, the code and the other docs are right.

Amble's web page came two ways before this, from the same React code:

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
| Files shared between people | Devices syncing with the server send it their files, and fetch the others' when they're opened (built 2026-10-16) | Files stay on the device that added them, as they already do with Drive |
| Drive access that renews in place in a browser | A refresh token takes Google's client secret, which a static page can't hold | A browser renews with a quick trip to Google while nobody's using the page (see [Keeping a browser signed in to Drive](#keeping-a-browser-signed-in-to-drive)) |
| A household with no Google at all | Sign-in with any OpenID provider, data on the server | Everything syncs through Google Drive |

The connector stands out. The others either have a device-side substitute or affect only people using a browser on a computer.

## Decided

- **The open-source app is the app.** What Jon runs is what anyone gets from the repository, with no setup that only works for him.
- **Three ways to start.** On first open: use Amble on this device only, sync with Google (signing in with Google is how Drive sync works), or point it at your own server, on the home network or through Tailscale, sign in however that server does, and sync with the server instead of Drive. Apple and others can come later as more options on the same screen. This settles [households without Google](#households-without-google).
- **Reminders never depend on an outside push service.** A reminder set on the phone is the phone's own alarm, as before. One set anywhere else (through Claude, or in a browser) reaches the phone through its background check: about every 15 minutes, the shortest Android allows, while the household syncs, the Android app reads the household's file and sets alarms for this person's coming reminders it hasn't scheduled itself (`android/.../ReminderCheck.java`). A reminder set elsewhere for less than about 15 minutes ahead may be late, and longer while the phone sits idle; nothing else in Amble is that time-sensitive. Firebase Cloud Messaging was tried and taken out again the same day: only the Firebase project an app was built with can send to it, so it works for whoever holds that project's key and nobody else, short of a relay the project would have to run for everyone.

## The proposal

- **The web app is the device build, everywhere.** The page people open is the same app as the Android one: data on the device, offline from the start, no account, synced through Drive.
- **The server is an add-on.** It syncs with the household file like any device and adds the connector, background work and, later, the extras below. It serves no app pages. What it shows is a few plain pages: sign-in, the one-tap consent when connecting an assistant, the list of connected assistants, connecting the server to Drive, and its privacy page.
- **Same address, when both are hosted together.** The app keeps the address people installed (for example `/amble/`), and the server's routes sit beside it: `/auth/*`, `/oauth/*`, `/mcp`, `/.well-known/*`, `/healthz` and its pages. The consent page moves from `/connect/<id>`, which the app also uses, to `/oauth/consent/<id>`.

Extras the server could add later, for people who run one:

- **Push for browsers.** A browser subscribes with the server's VAPID key and registers once after signing in to the server (same origin, so the session cookie just works). The server already knows every reminder's time through sync.
- **Sync without Google.** A state-file endpoint on the server, shaped like the Drive calls in `server/sync/drive.ts` (`server/sync/fake-drive.ts` shows how little that is), will let devices sync to the server instead of Drive: the "your own server" way to start. The phone's background check will read it the same way it reads Drive.

## What a browser user gains and loses

Gains: one app that works the same on a phone and a computer, works offline, needs no account or server, and keeps the data on the device and in their own Drive.

Losses, against the server's page today: reminders only while Amble is open, no calendar load until devices read calendars, no shared files, and no household-wide AI key. Each loss comes back for people who also run a server, through the extras above.

## Keeping a browser signed in to Drive

Built 2026-10-15 (`web/src/lib/google.ts`, `server/google-token.ts`). Before that, the web app got Drive access only through Google's redirect sign-in (`response_type=token`): the token lasted an hour, came with no refresh token, and when it ran out the app showed "Sync paused" and waited for a tap. Now it renews in two ways.

1. **In place, through a tiny token endpoint.** Google's recommended flow for single-page apps is the authorization code flow with PKCE, which gives a refresh token. For a "Web application" client, Google's token endpoint wants the client secret for that, including on every refresh. So a small endpoint holds the secret and adds it to the two calls, trading the code and refreshing, and nothing else. It stores nothing; the browser keeps its own refresh token. On an Amble server it's the `/google/token` route; for a web app with no server, the same code runs as a free Cloudflare Worker (`deploy/google-token-worker`). Sync keeps going with no reloads at all.
2. **Without an endpoint, by a quiet trip to Google.** When the token runs out, the page goes back through the same sign-in with `prompt=none` and `login_hint` set to the person's address. Google's documentation describes `prompt=none` as "Don't display any authentication or consent screens": while the person is signed in to Google and has already allowed Amble, it comes straight back with a new token. The trip reloads the page, so it happens only when Amble opens, when its tab is in the background with changes to send, or when the page has sat untouched for two minutes with nothing open or being typed in.

Both were tried in Chrome against Google with a real account: signing in through the code flow and refreshing in place, the quiet trip with no refresh token, and a quiet trip Google turns down, which shows Continue once and doesn't retry for six hours. Stopping sync forgets the refresh token instead of revoking it: Google would revoke the whole grant for that client, an Amble server's included. Setup is in [google-drive.md](google-drive.md#keeping-a-browser-signed-in).

## Calendar

Calendar events don't sync through the household file (each copy reads its own calendars), so today calendar load reaches only people on the server's page. Two ways to bring it to every device:

- **Each device reads its own calendar.** The Android app can ask for `calendar.readonly` through Android's Google sign-in and renew it silently; a browser renews it the same way as Drive access ([above](#keeping-a-browser-signed-in-to-drive)). `calendar.readonly` is a sensitive scope, so Amble's own Google project would need Google's verification before the public could use it.
- **The server shares busy minutes, not events.** The server already reads calendars. It could write each person's busy minutes per day into a synced table: no titles, so the household file stays as private as it is. This works only for households with a server.

Settle this before the server's page goes, since it's the last feature computers would visibly lose.

Decided and built 2026-10-15, a third way: the Android app reads the phone's calendars through Android's own calendar permission, so no Google scope or verification is involved, and only your own calendars count unless you pick others. The events stay on the phone; each person's busy minutes per day go into a synced table (`busy_days`), so every copy, a browser or the server included, sees how busy a day is and never what's on it. The server's Google Calendar code is gone.

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
- **Only on the server:** have each device sync with the server (Use my own server). Later (2026-10-16) the server's Drive option became one way: bringing a Drive household onto the server, not making one from it.
- **Files on tasks:** whatever was uploaded through the server's page stays on the server. Offer a way to download them before the page goes.
- **Sessions and push registrations:** dropped. People turn reminders on again on each device.

## Households without Google

Today a household can run entirely on a self-hosted server with another sign-in provider (Authelia, Keycloak and others; see [sign-in.md](sign-in.md)) and never touch Google. Dropping the server's page would take their app away unless devices can sync to the server itself.

Decided 2026-10-15: support it. Sync to the server (the state-file endpoint above) is one of the three ways to start, and it's built before the server's page goes.

## Risks

- **Quiet renewal depends on Google's session.** Someone signed out of Google in that browser, or who removed Amble's access, still gets the Continue button. That's the right outcome, and rare.
- **The token endpoint holds a secret.** It should answer only Amble's own origins, send nothing but Google's two token calls, and log nothing.
- **iPhones** get the web app only. Safari can clear a site's storage after 7 days without a visit unless it was added to the home screen, and reminders show only while Amble is open. The real answer is an iOS build of the Capacitor app, which needs a Mac and an Apple developer account.
- **The connector's reminder note was wrong** (fixed 2026-10-15). `set_reminder` warned that the person "hasn't turned on notifications on any device yet" whenever the server had no push registration for them, though the reminder reaches their phone through sync. It now warns only when the server neither pushes nor syncs.
- **One more move for installed web apps.** The device build's service worker replaces the server build's at the same address, and the app starts empty until the person joins the household again.

## Recommendation and order of work

Do it, in this order, with the week in step 3 as the point to decide:

1. Fix the connector's reminder note. Done.
2. Make a browser renew Drive access on its own: the `prompt=none` bounce first, then the token endpoint. Done. So is the phone's background check for reminders set elsewhere.
3. Host the device build beside the server's page (at `/amble/app/`, say) and use it on a computer for a week. Skipped: the device build was already in daily use on the phone.
4. Settle calendar: devices read their own, or the server shares busy minutes. Done, the phone reads its own ([Calendar](#calendar)).
5. Build sync to your own server, the third way to start (decided above). Done (`server/sync/hub.ts`). A phone without an AI key uses the server's model through it.
6. Point the app's address at the device build, turn the server's remaining pages into plain pages, and delete the server's app code. Done.
7. Update the docs. Done.

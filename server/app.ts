// The server: an add-on to the app, which runs on each device. It serves the app (the same one the
// Android app wraps), keeps one more copy of the household, and adds what only an always-on
// address can: the Claude and ChatGPT connector, devices syncing straight with it, background
// work, and a few plain pages for signing in and its own settings (server/site.ts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { aiProviderFor, createAi, type Ai } from './ai/client.ts';
import { googleToken } from './google-token.ts';
import { isAllowed, upsertMember } from './auth/members.ts';
import { NeedsName, redeemCode } from './auth/pairing.ts';
import { describeError, type Oidc, SignInError } from './auth/oidc.ts';
import { createSession, deleteSession, resolveSession, SESSION_COOKIE, SESSION_TTL_MS } from './auth/sessions.ts';
import type { Config } from './config.ts';
import { registerConnector } from './connector.ts';
import { SCHEMA } from './db/index.ts';
import type { FileStore } from './domain/files.ts';
import { createFileStore } from './lib/disk-files.ts';
import { html, page } from './pages.ts';
import { createGoogle } from './lib/google.ts';
import { registerSite, safeReturnTo } from './site.ts';
import { registerServerSettings } from './settings.ts';
import { codeGuesses, registerSyncHub, requestFrom } from './sync/hub.ts';
import { createServerSync, type ServerSync } from './sync/server.ts';
import { SyncSetupError } from './sync/service.ts';
import type { Db } from './db/index.ts';
import type { Env } from './env.ts';

const STATE_COOKIE = 'almanac_auth_state';
const webDist = fileURLToPath(new URL('../dist/web', import.meta.url));

export function createApp({
  db,
  config,
  oidc,
  fetchImpl,
  ai = createAi(config, db),
  sync = createServerSync({ db, config, google: createGoogle(config), schema: SCHEMA, ai }),
  files = createFileStore(config.dataDir),
}: {
  db: Db;
  config: Config;
  oidc: Oidc;
  /** The AI model for background work, and for devices that use the server's; tests pass their own. */
  ai?: Ai;
  /** Keeping the server in step with a household's devices through Google Drive. */
  sync?: ServerSync;
  /** Where the bytes of files on tasks are kept, for devices to share them through the server. */
  files?: FileStore;
  /** For fetching client metadata documents; tests swap it out. */
  fetchImpl?: typeof fetch;
}) {
  const base = config.basePath;
  const cookiePath = base || '/';
  const appUrl = (p: string) => `${base}${p}`;

  const app = new Hono<Env>({
    // Accept requests whether or not the reverse proxy stripped the base path.
    getPath: (req) => {
      const p = new URL(req.url).pathname;
      if (base && (p === base || p.startsWith(`${base}/`))) return p.slice(base.length) || '/';
      return p;
    },
  });

  app.use(secureHeaders({ crossOriginEmbedderPolicy: false }));

  // The address the app used to live at (AMBLE_REDIRECT_FROM) sends links and requests on here.
  // An app installed from there gets a service worker that steps aside and moves its window over,
  // since browsers won't follow a redirect when they check for a new service worker.
  const from = config.redirectFrom;
  if (from && from !== base) {
    app.use('*', async (c, next) => {
      const url = new URL(c.req.url);
      if (url.pathname !== from && !url.pathname.startsWith(`${from}/`)) return next();
      const rest = url.pathname.slice(from.length);
      if (rest === '/sw.js') {
        c.header('Content-Type', 'text/javascript');
        c.header('Cache-Control', 'no-cache');
        return c.body(
          `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const w of await self.clients.matchAll({ type: 'window' })) w.navigate(${JSON.stringify(`${config.publicOrigin}${base}/`)});
})()));`,
        );
      }
      return c.redirect(`${config.publicOrigin}${base}${rest}${url.search}`, c.req.method === 'GET' || c.req.method === 'HEAD' ? 301 : 308);
    });
  }

  // Keeps the app signed in to Drive in a browser: it adds the client secret to Google's token
  // calls (server/google-token.ts). Before the middleware below, since it changes nothing here.
  const { clientId, clientSecret } = config.google;
  if (clientId && clientSecret) {
    app.on(['POST', 'OPTIONS'], '/google/token', (c) => googleToken(c.req.raw, { clientId, clientSecret, origins: config.appOrigins, fetchImpl }));
  }

  // Whatever a request changed (a device's round, or an assistant's through the connector) goes
  // out to Google Drive soon after, when the server syncs with a household's devices.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') sync.soon();
  });

  // Signed in on this server's own pages (sign-in, consent, its settings): a cookie. Devices and
  // assistants carry tokens instead.
  app.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('member', token ? resolveSession(db, token) : null);
    await next();
  });

  for (const p of ['/auth/*', '/server/*', '/oauth/consent/*']) app.use(p, csrf({ origin: config.publicOrigin }));

  app.get('/healthz', (c) => c.json({ ok: true }));

  function startSession(c: Context<Env>, memberId: string) {
    const token = createSession(db, memberId, c.req.header('user-agent'));
    setCookie(c, SESSION_COOKIE, token, {
      path: cookiePath,
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Lax',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  }

  app.get('/auth/login', async (c) => {
    const returnTo = safeReturnTo(c.req.query('return'));
    // With dev sign-in on, the sign-in page offers it beside the real one, which links back here.
    if (config.devLogin && !c.req.query('direct')) return c.redirect(appUrl(`/auth/signin?return=${encodeURIComponent(returnTo)}`));
    // Without a sign-in provider, a code from a device that's already in is the way.
    if (!oidc.enabled) return c.redirect(appUrl(`/auth/signin?return=${encodeURIComponent(returnTo)}`));
    let started;
    try {
      started = await oidc.begin(returnTo);
    } catch (err) {
      console.warn('Sign-in could not start:', describeError(err));
      return c.redirect(appUrl('/auth/signin?error=unavailable'));
    }
    const { url, state } = started;
    setCookie(c, STATE_COOKIE, state, {
      path: cookiePath,
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Lax',
      maxAge: 600,
    });
    return c.redirect(url);
  });

  // Connecting Google Drive, for syncing with a household's devices: an admin's choice, through
  // the same redirect as sign-in.
  app.get('/auth/drive', async (c) => {
    const member = c.get('member');
    if (!member) return c.redirect(appUrl('/auth/signin?return=/server'));
    if (member.role !== 'admin' || !sync.enabled) return c.redirect(appUrl('/server?error=off'));
    const { url, state } = await oidc.beginDrive(member.id, member.email, '/server');
    setCookie(c, STATE_COOKIE, state, { path: cookiePath, httpOnly: true, secure: config.secureCookies, sameSite: 'Lax', maxAge: 600 });
    return c.redirect(url);
  });

  app.get('/auth/callback', async (c) => {
    const state = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: cookiePath });
    if (!state || state !== c.req.query('state')) return c.redirect(appUrl('/auth/signin?error=expired'));
    // Someone who backs out of Google's consent screen lands here with an error and no code.
    const declined = c.req.query('error');
    let identity;
    try {
      identity = await oidc.finish(state, new URL(c.req.url).search);
    } catch (err) {
      console.warn('Sign-in failed:', describeError(err));
      if (c.get('member')) return c.redirect(appUrl(`/server?error=${declined ? 'declined' : 'failed'}`));
      return c.redirect(appUrl(`/auth/signin?error=${err instanceof SignInError ? err.code : 'failed'}`));
    }
    if (identity.kind === 'drive') {
      if (c.get('member')?.id !== identity.memberId) return c.redirect(appUrl('/auth/signin?error=expired'));
      try {
        sync.saveGrant(identity);
      } catch (err) {
        if (!(err instanceof SyncSetupError)) throw err;
        return c.redirect(appUrl(`/server?error=${encodeURIComponent(err.message)}`));
      }
      return c.redirect(appUrl(`/server?done=${encodeURIComponent('Connected Google Drive. Now join the household’s file.')}`));
    }
    if (!isAllowed(db, config, identity.email)) {
      console.warn(`Sign-in refused for ${identity.email}: not on the allowlist`);
      return c.redirect(appUrl('/auth/signin?error=not-allowed'));
    }
    const member = upsertMember(db, config, identity);
    startSession(c, member.id);
    return c.redirect(appUrl(identity.returnTo));
  });

  app.get('/auth/dev', (c) => {
    const email = (c.req.query('email') ?? '').toLowerCase();
    if (!config.devLogin || !isAllowed(db, config, email)) return c.notFound();
    const member = upsertMember(db, config, { email });
    startSession(c, member.id);
    return c.redirect(appUrl(safeReturnTo(c.req.query('return'))));
  });

  // A browser getting in with a code from a device that's already in, for this server's own pages
  // (an assistant's consent among them). An invite for someone new asks their name first.
  const guesses = codeGuesses();
  app.post('/auth/code', async (c) => {
    const form = await c.req.parseBody();
    const code = String(form.code ?? '');
    const name = String(form.name ?? '').trim();
    const returnTo = safeReturnTo(String(form.return ?? ''));
    const back = (error: string) => c.redirect(appUrl(`/auth/signin?error=${error}&return=${encodeURIComponent(returnTo)}`));
    const from = requestFrom(c);
    if (guesses.blocked(from)) return back('too-many');
    let member;
    try {
      member = redeemCode(db, config, code, { name: name || undefined });
    } catch (err) {
      if (!(err instanceof NeedsName)) throw err;
      return c.html(
        page(
          'Sign in',
          html`<h1>What should Amble call you?</h1>
<p class="muted">You're new to this household, so Amble needs a name for you.</p>
<form method="post" action="${appUrl('/auth/code')}">
<input type="hidden" name="code" value="${code}">
<input type="hidden" name="return" value="${returnTo}">
<input name="name" autocomplete="given-name" required maxlength="80" placeholder="Your first name" aria-label="Your name" autofocus>
<div class="actions"><button class="primary">Continue</button></div>
</form>`,
          { base },
        ),
      );
    }
    if (!member) {
      guesses.missed(from);
      return back('code');
    }
    startSession(c, member.id);
    return c.redirect(appUrl(returnTo));
  });

  app.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: cookiePath });
    // From the server's page, a form: back to signing in.
    return (c.req.header('content-type') ?? '').includes('form') ? c.redirect(appUrl('/auth/signin')) : c.body(null, 204);
  });

  // Devices syncing straight with this server, and signing them in.
  registerSyncHub(app, { db, config, service: sync.service, schema: SCHEMA, ai, files });

  // OAuth, discovery, consent and /mcp for the assistant connector.
  const connector = registerConnector(app, { db, config, fetchImpl });

  registerSite(app, { db, config, oidc, sync, ai, connector });
  // The same, for the app on a device that syncs here (Settings, Your server).
  registerServerSettings(app, { db, config, ai, sync, connector });

  // What the app asked this server for before the app moved to the device.
  app.all('/api/*', (c) => c.json({ error: 'Amble runs on your device now. Reload to get the new version.' }, 410));

  // The app. Its page learns from the server where it's served from and that it can sync here.
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    const google = clientId
      ? {
          clientId,
          apiKey: process.env.AMBLE_GOOGLE_API_KEY ?? '',
          // A Google client id begins with its Cloud project's number, which the file picker wants.
          appId: /^(\d+)-/.exec(clientId)?.[1] ?? '',
          tokenUrl: clientSecret ? `${config.publicUrl}/google/token` : '',
        }
      : null;
    const settings = {
      basePath: base,
      // Its sign-in provider, if it has one (dev sign-in counts); without, people get in with codes.
      server: {
        url: config.publicUrl,
        signIn: oidc.enabled ? config.oidc.providerName : config.devLogin ? 'a test account' : null,
        privacyContact: config.privacyContact,
        ai: aiProviderFor(ai),
      },
      google,
      // Lets scripts that drive the app ask it directly (scripts/lib/household.ts).
      ...(config.devLogin ? { test: true } : {}),
    };
    const indexHtml = fs
      .readFileSync(path.join(webDist, 'index.html'), 'utf8')
      .replace(/<base href="[^"]*" ?\/?>/, '')
      .replace('<head>', `<head><base href="${base}/"><script>window.__AMBLE__=${JSON.stringify(settings).replace(/</g, '\\u003c')}</script>`);
    const root = path.relative(process.cwd(), webDist) || '.';
    const serveIndex = (c: Context<Env>) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    };
    // Registered before serveStatic, which would otherwise answer "/" with the raw index.html.
    app.get('/', serveIndex);
    app.get('/index.html', serveIndex);
    // The service worker checks for a new version on every visit, so it must never come from a cache.
    app.use('/sw.js', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    app.use(
      '/assets/*',
      async (c, next) => {
        await next();
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
      serveStatic({ root }),
    );
    app.use('*', serveStatic({ root }));
    app.get('*', serveIndex);
  }

  return app;
}

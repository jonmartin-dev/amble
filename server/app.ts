import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { aiProviderFor, createAi, type Ai } from './ai/client.ts';
import { createGoogle } from './calendar/google.ts';
import { ConnectError, createCalendarSync, type CalendarSync } from './calendar/sync.ts';
import { createFileStore, type FileStore } from './domain/files.ts';
import { createPush, type Push } from './notify/push.ts';
import { allowedEmails, isAllowed, upsertMember } from './auth/members.ts';
import { describeError, type Oidc, SignInError } from './auth/oidc.ts';
import { createSession, deleteSession, resolveSession, SESSION_COOKIE, SESSION_TTL_MS } from './auth/sessions.ts';
import type { Config } from './config.ts';
import { registerApi } from './api.ts';
import { registerConnector } from './connector.ts';
import { queuedWrites } from './requests.ts';
import type { Db } from './db/index.ts';
import type { Env } from './env.ts';
import { z } from 'zod';
import { members } from './db/schema.ts';
import { MAX_CAPACITY_MINUTES } from './domain/load.ts';

const STATE_COOKIE = 'almanac_auth_state';
const webDist = fileURLToPath(new URL('../dist/web', import.meta.url));

/** Only allow same-app relative paths as post-login destinations. */
function safeReturnTo(value: string | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

export function createApp({
  db,
  config,
  oidc,
  fetchImpl,
  ai = createAi(config, db),
  calendar = createCalendarSync({ db, config, google: createGoogle(config) }),
  push = createPush(db, config),
  files = createFileStore(config.dataDir),
}: {
  db: Db;
  config: Config;
  oidc: Oidc;
  /** The AI model for smart add and planning help; tests pass their own. */
  ai?: Ai;
  /** Google Calendar sync; tests pass one talking to a fake Google. */
  calendar?: CalendarSync;
  /** Web push for reminders; tests pass one with a fake sender. */
  push?: Push;
  /** Where files on tasks are kept; tests pass a temporary folder. */
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

  app.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('member', token ? resolveSession(db, token) : null);
    await next();
  });

  app.use('/api/*', csrf({ origin: config.publicOrigin }));
  app.use('/auth/*', csrf({ origin: config.publicOrigin }));

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
    if (!oidc.enabled) {
      if (config.devLogin) return c.redirect(appUrl(`/signin?return=${encodeURIComponent(returnTo)}`));
      return c.text('Sign-in is not configured. Set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.', 503);
    }
    let started;
    try {
      started = await oidc.begin(returnTo);
    } catch (err) {
      console.warn('Sign-in could not start:', describeError(err));
      return c.redirect(appUrl('/signin?error=unavailable'));
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

  // Connecting a Google Calendar: the same redirect URI as sign-in, so the OAuth client needs
  // nothing new registered.
  app.get('/auth/calendar', async (c) => {
    const member = c.get('member');
    if (!member) return c.redirect(appUrl('/signin?return=/settings/calendars'));
    if (!oidc.calendarEnabled) return c.redirect(appUrl('/settings/calendars?error=off'));
    const { url, state } = await oidc.beginCalendar(member.id, member.email, '/settings/calendars');
    setCookie(c, STATE_COOKIE, state, { path: cookiePath, httpOnly: true, secure: config.secureCookies, sameSite: 'Lax', maxAge: 600 });
    return c.redirect(url);
  });

  app.get('/auth/callback', async (c) => {
    const state = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: cookiePath });
    if (!state || state !== c.req.query('state')) return c.redirect(appUrl('/signin?error=expired'));
    // Someone who backs out of Google's consent screen lands here with an error and no code.
    const declined = c.req.query('error');
    let identity;
    try {
      identity = await oidc.finish(state, new URL(c.req.url).search);
    } catch (err) {
      console.warn('Sign-in failed:', describeError(err));
      if (c.get('member')) return c.redirect(appUrl(`/settings/calendars?error=${declined ? 'declined' : 'failed'}`));
      return c.redirect(appUrl(`/signin?error=${err instanceof SignInError ? err.code : 'failed'}`));
    }
    if (identity.kind === 'calendar') {
      if (c.get('member')?.id !== identity.memberId) return c.redirect(appUrl('/signin?error=expired'));
      try {
        await calendar.connect(identity);
      } catch (err) {
        if (!(err instanceof ConnectError)) throw err;
        return c.redirect(appUrl(`/settings/calendars?error=${encodeURIComponent(err.message)}`));
      }
      return c.redirect(appUrl(`${identity.returnTo}?connected=1`));
    }
    if (!isAllowed(db, config, identity.email)) {
      console.warn(`Sign-in refused for ${identity.email}: not on the allowlist`);
      return c.redirect(appUrl('/signin?error=not-allowed'));
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

  app.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: cookiePath });
    return c.body(null, 204);
  });

  // OAuth, discovery and /mcp for the Claude connector. Its signed-in API goes in below the guard.
  const registerConnectorApi = registerConnector(app, { db, config, fetchImpl });

  app.get('/api/session', (c) =>
    c.json({
      member: c.get('member'),
      auth: {
        provider: config.oidc.providerName,
        oidc: oidc.enabled,
        privacyContact: config.privacyContact,
        // Who AI features send things to, for the privacy page.
        ai: aiProviderFor(ai),
        devEmails: config.devLogin ? allowedEmails(db, config) : [],
      },
    }),
  );

  app.use('/api/*', async (c, next) => {
    if (!c.get('member')) return c.json({ error: 'Sign in first.' }, 401);
    await next();
  });
  app.use('/api/*', queuedWrites(db));

  const themeSchema = z.object({
    mode: z.enum(['system', 'light', 'dark']),
    seed: z.string().regex(/^#[0-9a-f]{6}$/i),
    style: z.enum(['tonal', 'expressive', 'vibrant', 'fidelity', 'neutral']),
    contrast: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
  });

  app.patch('/api/me', async (c) => {
    // theme: null resets to the default theme.
    // capacity: null resets every weekday to the default; a missing weekday uses the default too.
    const parsed = z
      .object({
        theme: themeSchema.nullable().optional(),
        capacity: z
          .partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.number().int().min(0).max(MAX_CAPACITY_MINUTES))
          .nullable()
          .optional(),
        showStreaks: z.boolean().optional(),
        smartAdd: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Those settings look wrong. Try again.' }, 400);
    const me = c.get('member')!;
    const { theme, capacity, showStreaks, smartAdd } = parsed.data;
    const updated = db
      .update(members)
      .set({
        ...(theme !== undefined && { theme }),
        ...(capacity !== undefined && { capacity }),
        ...(showStreaks !== undefined && { showStreaks }),
        ...(smartAdd !== undefined && { smartAdd }),
      })
      .where(eq(members.id, me.id))
      .returning()
      .get();
    return c.json({ member: updated });
  });

  registerApi(app, { db, config, ai, calendar, push, files });
  registerConnectorApi(app);

  app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

  // Built front end. In development Vite serves it instead.
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    const indexHtml = fs
      .readFileSync(path.join(webDist, 'index.html'), 'utf8')
      .replace(
        '<head>',
        `<head><base href="${base}/"><script>window.__ALMANAC__=${JSON.stringify({ basePath: base })}</script>`,
      );
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

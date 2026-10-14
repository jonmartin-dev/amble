import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { allowedEmails, isAllowed, upsertMember } from './auth/members.ts';
import type { Oidc } from './auth/oidc.ts';
import { createSession, deleteSession, resolveSession, SESSION_COOKIE, SESSION_TTL_MS } from './auth/sessions.ts';
import type { Config } from './config.ts';
import { registerApi } from './api.ts';
import { registerConnector } from './connector.ts';
import type { Db } from './db/index.ts';
import type { Env } from './env.ts';
import { z } from 'zod';
import { members } from './db/schema.ts';

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
}: {
  db: Db;
  config: Config;
  oidc: Oidc;
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
    const { url, state } = await oidc.begin(returnTo);
    setCookie(c, STATE_COOKIE, state, {
      path: cookiePath,
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Lax',
      maxAge: 600,
    });
    return c.redirect(url);
  });

  app.get('/auth/callback', async (c) => {
    const state = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: cookiePath });
    if (!state || state !== c.req.query('state')) return c.redirect(appUrl('/signin?error=expired'));
    let identity;
    try {
      identity = await oidc.finish(state, new URL(c.req.url).search);
    } catch (err) {
      console.warn('Sign-in failed:', err instanceof Error ? err.message : err);
      return c.redirect(appUrl('/signin?error=failed'));
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
        devEmails: config.devLogin ? allowedEmails(db, config) : [],
      },
    }),
  );

  app.use('/api/*', async (c, next) => {
    if (!c.get('member')) return c.json({ error: 'Sign in first.' }, 401);
    await next();
  });

  const themeSchema = z.object({
    mode: z.enum(['system', 'light', 'dark']),
    seed: z.string().regex(/^#[0-9a-f]{6}$/i),
    style: z.enum(['tonal', 'expressive', 'vibrant', 'fidelity', 'neutral']),
    contrast: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
  });

  app.patch('/api/me', async (c) => {
    // theme: null resets to the default theme.
    const parsed = z.object({ theme: themeSchema.nullable().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Those settings look wrong. Try again.' }, 400);
    const me = c.get('member')!;
    const updated = db
      .update(members)
      .set({ ...(parsed.data.theme !== undefined && { theme: parsed.data.theme }) })
      .where(eq(members.id, me.id))
      .returning()
      .get();
    return c.json({ member: updated });
  });

  registerApi(app, { db, config });
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

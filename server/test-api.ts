// For tests: the app's API (server/api.ts) on its own, the way each device runs it, but for
// several people at once: each test signs in with a session cookie, as on a server.
import { getCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { createAi, type Ai } from './ai/client.ts';
import { registerApi } from './api.ts';
import { resolveSession, SESSION_COOKIE } from './auth/sessions.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { FileStore } from './domain/files.ts';
import type { Env } from './env.ts';
import { createLocalPush } from './notify/local-push.ts';
import type { Push } from './notify/devices.ts';
import { queuedWrites } from './requests.ts';

const noFiles: FileStore = {
  save: async () => {
    throw new Error('No files in this test.');
  },
  get: async () => null,
  sweep: async () => 0,
};

export function apiApp({ db, config, ai = createAi(config, db), push = createLocalPush(db, async () => true), files = noFiles }: { db: Db; config: Config; ai?: Ai; push?: Push; files?: FileStore }) {
  const app = new Hono<Env>({
    getPath: (req) => {
      const p = new URL(req.url).pathname;
      const base = config.basePath;
      return base && p.startsWith(`${base}/`) ? p.slice(base.length) : p;
    },
  });
  app.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('member', token ? resolveSession(db, token) : null);
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (!c.get('member')) return c.json({ error: 'Sign in first.' }, 401);
    await next();
  });
  app.use('/api/*', queuedWrites(db));
  registerApi(app, { db, config, ai, push, files });
  app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
  return app;
}

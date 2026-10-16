// Amble with no server: the same API, run inside the app on the device (web/src/worker/). There's
// no sign-in; the person using this device is the member it was set up for, and everything stays
// in the device's own database until they choose to sync it.
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { aiProviderFor, type Ai } from './ai/client.ts';
import { registerApi } from './api.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { members, serverSettings, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import type { FileStore } from './domain/files.ts';
import type { Env } from './env.ts';
import type { Push } from './notify/devices.ts';
import { queuedWrites } from './requests.ts';
import { adoptMember, foldDuplicateGroups, SyncSetupError, type Adopt, type SyncService } from './sync/service.ts';

/** Members made on a device have no email until they sign in with one; this stands in for it. */
export const DEVICE_EMAIL_DOMAIN = 'device.invalid';
export const isDeviceEmail = (email: string) => email.endsWith(`@${DEVICE_EMAIL_DOMAIN}`);

interface DeviceSettings {
  memberId: string;
}

export function deviceSettings(db: Db): DeviceSettings | null {
  return (db.select().from(serverSettings).where(eq(serverSettings.key, 'device')).get()?.value as DeviceSettings | undefined) ?? null;
}

/** Who uses this device, once it's set up. */
export function deviceMember(db: Db): Member | null {
  const settings = deviceSettings(db);
  if (!settings) return null;
  return db.select().from(members).where(eq(members.id, settings.memberId)).get() ?? null;
}

function setDeviceMember(db: Db, memberId: string) {
  const value = { memberId } satisfies DeviceSettings;
  db.insert(serverSettings).values({ key: 'device', value }).onConflictDoUpdate({ target: serverSettings.key, set: { value } }).run();
}

/**
 * Once a device knows whose Google account it syncs with: it becomes that person's member if the
 * synced data has one (taking along anything made here first), or its own member takes the
 * account's address. A device that started on its own folds its starter groups into the
 * household's.
 */
export function deviceAdopt(db: Db, config: Config): Adopt {
  return (account, localGroups, remote) => {
    const mine = deviceMember(db);
    const theirs = db.select().from(members).where(eq(members.email, account.email)).get();
    if (!mine) {
      if (theirs) return setDeviceMember(db, theirs.id);
      const started = startDevice(db, config, account.name ?? account.email.split('@')[0]!);
      db.update(members).set({ email: account.email }).where(eq(members.id, started.id)).run();
      return;
    }
    if (theirs && theirs.id !== mine.id) {
      adoptMember(db, mine.id, theirs.id);
      setDeviceMember(db, theirs.id);
    } else if (isDeviceEmail(mine.email)) {
      db.update(members).set({ email: account.email }).where(eq(members.id, mine.id)).run();
    }
    if (remote) foldDuplicateGroups(db, localGroups);
  };
}

/** Sets the device up for its first person, with the starter groups. */
export function startDevice(db: Db, config: Config, name: string): Member {
  const existing = deviceMember(db);
  if (existing) return existing;
  return db.transaction(() => {
    const id = crypto.randomUUID();
    const member = db
      .insert(members)
      .values({ id, email: `${id}@${DEVICE_EMAIL_DOMAIN}`, name, role: 'admin', timezone: config.timezone })
      .returning()
      .get();
    setDeviceMember(db, member.id);
    seedStarterGroups(db);
    return member;
  });
}

export function createLocalApp({
  db,
  config,
  ai,
  push,
  files,
  sync,
}: {
  db: Db;
  config: Config;
  ai: Ai;
  push: Push;
  files: FileStore;
  sync?: SyncService;
}) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.set('member', deviceMember(db));
    await next();
    // Whatever a request changed gets its time for sync.
    if (c.req.method !== 'GET') sync?.stamp();
  });

  app.get('/api/session', (c) =>
    c.json({
      member: c.get('member'),
      auth: { provider: 'device', oidc: false, devEmails: [], privacyContact: config.privacyContact, ai: aiProviderFor(ai), mode: 'device' },
    }),
  );

  if (sync) registerSync(app, sync, db);

  app.post('/api/device/start', async (c) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Say what Amble should call you.' }, 400);
    return c.json({ member: startDevice(db, config, parsed.data.name) }, 201);
  });

  app.use('/api/*', async (c, next) => {
    if (!c.get('member')) return c.json({ error: 'Set up Amble on this device first.' }, 401);
    await next();
  });
  app.use('/api/*', queuedWrites(db));

  registerApi(app, { db, config, ai, push, files });

  app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
  return app;
}

const token = z.object({ token: z.string().min(10).max(4000) });

/**
 * Sync through Google Drive. The app gets the access token from Google in the page and hands it
 * over with each call; it stays on the device.
 */
function registerSync(app: Hono<Env>, sync: SyncService, db: Db) {
  const parse = async <T extends z.ZodType>(c: Context<Env>, schema: T) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new SyncSetupError("That request doesn't look right.");
    return parsed.data as z.output<T>;
  };
  // Setup problems are worth saying as they are; the API's own error handler is for everything else.
  const answer = (fn: (c: Context<Env>) => Promise<Response>) => async (c: Context<Env>) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof SyncSetupError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };
  const how = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('personal') }),
    z.object({ mode: z.literal('create'), name: z.string().trim().min(1).max(100) }),
    z.object({ mode: z.literal('join'), fileId: z.string().min(1).max(200) }),
  ]);

  app.get('/api/sync', (c) => c.json(sync.status()));

  // Allowed before the device is set up: that's how a second device starts from what's in Drive.
  app.post(
    '/api/sync/connect',
    answer(async (c) => {
      const { token: t, ...rest } = await parse(c, token.and(how));
      return c.json(await sync.connect(t, rest));
    }),
  );

  app.post(
    '/api/sync/households',
    answer(async (c) => {
      const files = await sync.households((await parse(c, token)).token);
      return c.json({ households: files.map((f) => ({ id: f.id, name: f.name, owner: f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? null })) });
    }),
  );

  app.use('/api/sync/*', async (c, next) => {
    if (!deviceMember(db)) return c.json({ error: 'Set up Amble on this device first.' }, 401);
    await next();
  });

  app.post(
    '/api/sync/run',
    answer(async (c) => c.json(await sync.run((await parse(c, token)).token))),
  );

  app.post(
    '/api/sync/people',
    answer(async (c) => {
      const people = await sync.people((await parse(c, token)).token);
      return c.json({ people: people.map((p) => ({ id: p.id, email: p.emailAddress ?? null, name: p.displayName ?? null, role: p.role })) });
    }),
  );

  app.post(
    '/api/sync/share',
    answer(async (c) => {
      const input = await parse(c, token.and(z.object({ email: z.email().max(200), name: z.string().max(80).default('') })));
      await sync.share(input.token, input.email, input.name, deviceMember(db)!.name);
      return c.json({ ok: true });
    }),
  );

  app.delete('/api/sync', async (c) => {
    await sync.off();
    return c.json(sync.status());
  });
}

/** A configuration for running on a device: no server address, sign-in, or environment. */
export function deviceConfig(origin: string, basePath: string, timezone: string): Config {
  return {
    production: true,
    port: 0,
    host: '',
    publicUrl: `${origin}${basePath}`,
    basePath,
    redirectFrom: '',
    publicOrigin: origin,
    secureCookies: origin.startsWith('https://'),
    dataDir: '/',
    timezone,
    privacyContact: '',
    adminEmails: [],
    allowedEmails: [],
    oidc: { issuer: '', providerName: '', clientId: '', clientSecret: '' },
    google: { clientId: '', clientSecret: '' },
    googleTokenOrigins: [],
    maxFileBytes: 25 * 1024 * 1024,
    devLogin: false,
    oauthClientHosts: [],
    ai: { provider: 'anthropic', apiKey: '', model: '', baseUrl: '', effort: undefined, monthlyCapUsd: 10, prices: undefined },
  };
}

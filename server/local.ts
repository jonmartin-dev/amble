// Almanac with no server: the same API, run inside the app on the device (web/src/worker/). There's
// no sign-in; the person using this device is the member it was set up for, and everything stays
// in the device's own database until they choose to sync it.
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { aiProviderFor, type Ai } from './ai/client.ts';
import { registerApi } from './api.ts';
import type { CalendarSync } from './calendar/sync.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { members, serverSettings, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import type { FileStore } from './domain/files.ts';
import type { Env } from './env.ts';
import type { Push } from './notify/devices.ts';
import { queuedWrites } from './requests.ts';

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
    db.insert(serverSettings).values({ key: 'device', value: { memberId: member.id } satisfies DeviceSettings }).run();
    seedStarterGroups(db);
    return member;
  });
}

export function createLocalApp({
  db,
  config,
  ai,
  calendar,
  push,
  files,
}: {
  db: Db;
  config: Config;
  ai: Ai;
  calendar: CalendarSync;
  push: Push;
  files: FileStore;
}) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.set('member', deviceMember(db));
    await next();
  });

  app.get('/api/session', (c) =>
    c.json({
      member: c.get('member'),
      auth: { provider: 'device', oidc: false, devEmails: [], privacyContact: config.privacyContact, ai: aiProviderFor(ai), mode: 'device' },
    }),
  );

  app.post('/api/device/start', async (c) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Say what Almanac should call you.' }, 400);
    return c.json({ member: startDevice(db, config, parsed.data.name) }, 201);
  });

  app.use('/api/*', async (c, next) => {
    if (!c.get('member')) return c.json({ error: 'Set up Almanac on this device first.' }, 401);
    await next();
  });
  app.use('/api/*', queuedWrites(db));

  registerApi(app, { db, config, ai, calendar, push, files });

  app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
  return app;
}

/** A configuration for running on a device: no server address, sign-in, or environment. */
export function deviceConfig(origin: string, basePath: string, timezone: string): Config {
  return {
    production: true,
    port: 0,
    host: '',
    publicUrl: `${origin}${basePath}`,
    basePath,
    publicOrigin: origin,
    secureCookies: origin.startsWith('https://'),
    dataDir: '/',
    timezone,
    privacyContact: '',
    adminEmails: [],
    allowedEmails: [],
    oidc: { issuer: '', providerName: '', clientId: '', clientSecret: '' },
    calendar: { clientId: '', clientSecret: '' },
    maxFileBytes: 25 * 1024 * 1024,
    devLogin: false,
    oauthClientHosts: [],
    ai: { provider: 'anthropic', apiKey: '', model: '', baseUrl: '', effort: undefined, monthlyCapUsd: 10, prices: undefined },
  };
}

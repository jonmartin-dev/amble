import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAi } from './ai/client.ts';
import { openDatabase } from './db/index.ts';
import { FileTooBig, type FileStore } from './domain/files.ts';
import { createLocalApp, deviceConfig, isDeviceEmail } from './local.ts';
import { createLocalPush } from './notify/local-push.ts';
import type { PushMessage } from './notify/devices.ts';
import { drizzleOn, type Db } from './db/open.ts';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { applyMigrations } from './db/open.ts';
import { asBetterSqlite, WasmClient } from './db/wasm.ts';
import { fileURLToPath } from 'node:url';

/** Files kept in memory, as a stand-in for the browser's private file system. */
export function memoryFiles(): FileStore {
  const stored = new Map<string, Uint8Array>();
  return {
    async save(body, limit) {
      if (!body) throw new Error('empty');
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.length > limit) throw new FileTooBig('too big');
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      stored.set(sha256, bytes);
      return { sha256, size: bytes.length };
    },
    async get(sha256) {
      const bytes = stored.get(sha256);
      if (!bytes) return null;
      return { size: bytes.length, stream: () => new Blob([bytes as BlobPart]).stream(), bytes: async () => bytes };
    },
    async sweep(used) {
      let n = 0;
      for (const sha of stored.keys()) if (!used.has(sha) && stored.delete(sha)) n++;
      return n;
    },
  };
}

let sqlite3: Sqlite3Static;
let db: Db;
let shown: PushMessage[];
let app: ReturnType<typeof createLocalApp>;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  db = drizzleOn(asBetterSqlite(new WasmClient(sqlite3, new sqlite3.oo1.DB(':memory:', 'c'))));
  applyMigrations(db, readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) }));
  const config = deviceConfig('https://amble.example', '', 'America/Chicago');
  shown = [];
  app = createLocalApp({
    db,
    config,
    ai: createAi(config, db, fetch, { seal: (k) => k, open: (k) => k }),
    push: createLocalPush(db, async (m) => {
      shown.push(m);
      return true;
    }),
    files: memoryFiles(),
  });
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`https://amble.example/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
};

describe('Amble on a device', () => {
  it('answers under the path the app is served at', async () => {
    const config = deviceConfig('https://amble.example', '/amble', 'America/Chicago');
    const served = createLocalApp({ db, config, ai: createAi(config, db, fetch, { seal: (k) => k, open: (k) => k }), push: createLocalPush(db, async () => true), files: memoryFiles() });
    const res = await served.request('https://amble.example/amble/api/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ member: null });
  });

  it('starts with nobody, then sets up its person with the starter groups', async () => {
    expect((await call('GET', '/session')).json).toMatchObject({ member: null, auth: { mode: 'device' } });
    expect((await call('GET', '/groups')).status).toBe(401);
    const started = await call('POST', '/device/start', { name: 'Sam' });
    expect(started.status).toBe(201);
    expect(started.json.member).toMatchObject({ name: 'Sam', role: 'admin', timezone: 'America/Chicago' });
    expect(isDeviceEmail(started.json.member.email)).toBe(true);
    // Starting again keeps the same person.
    expect((await call('POST', '/device/start', { name: 'Someone else' })).json.member.id).toBe(started.json.member.id);
    const groups = (await call('GET', '/groups')).json.groups.map((g: { name: string }) => g.name);
    expect(groups).toEqual(['Home', 'Errands', 'Groceries', 'Calls', 'Projects', 'Hobby']);
  });

  it('runs the whole API: tasks, today, lists, files and reminders', async () => {
    await call('POST', '/device/start', { name: 'Sam' });
    const me = (await call('GET', '/session')).json.member;
    const today = (await call('GET', '/today')).json.today;
    const task = (await call('POST', '/tasks', { title: 'Water the plants', plannedDate: today, estimateMinutes: 10 })).json.task;
    expect((await call('GET', '/today')).json.planned.map((t: { title: string }) => t.title)).toEqual(['Water the plants']);

    const groceries = (await call('GET', '/groups')).json.groups.find((g: { name: string }) => g.name === 'Groceries');
    await call('POST', `/lists/${groceries.id}/items`, { name: 'milk' });
    await call('POST', `/lists/${groceries.id}/items`, { name: 'bananas' });
    const list = (await call('GET', `/lists/${groceries.id}`)).json;
    expect(list.open.map((i: { name: string; section: string }) => [i.name, i.section])).toEqual(
      expect.arrayContaining([
        ['milk', 'Dairy & eggs'],
        ['bananas', 'Produce'],
      ]),
    );

    const upload = await app.request(`https://amble.example/api/tasks/${task.id}/files?name=note.txt`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'two cups a week',
    });
    expect(upload.status).toBe(201);
    const file = (await upload.json()).file;
    const back = await app.request(`https://amble.example/api/files/${file.id}`);
    expect(await back.text()).toBe('two cups a week');

    await call('POST', '/push/subscriptions', { endpoint: 'device:this-browser', keys: { p256dh: '-', auth: '-' } });
    expect((await call('GET', '/push')).json.devices).toHaveLength(1);
    expect((await call('POST', '/push/test')).json).toMatchObject({ devices: 1, sent: 1 });
    expect(shown[0]).toMatchObject({ title: 'Notifications are on' });

    expect((await call('POST', `/tasks/${task.id}/complete`, { done: true })).json.task).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    expect((await call('PATCH', '/me', { showStreaks: false })).json.member).toMatchObject({ id: me.id, showStreaks: false });
  });

  it("takes in the phone's calendars and their events, including ones Android leaves fields out of", async () => {
    await call('POST', '/device/start', { name: 'Sam' });
    expect((await call('GET', '/calendars')).json).toEqual({ on: false, calendars: [], sharedDays: 0 });
    // Android leaves out what a calendar or event doesn't have, like a color or an event's id.
    const listed = await call('PUT', '/calendars/phone', { calendars: [{ id: '7', name: 'Mine', primary: true, writable: true, visible: true }] });
    expect(listed.json.counting).toEqual(['7']);
    const today = (await call('GET', '/today')).json.today;
    const at = (time: string) => Temporal.PlainDateTime.from(`${today}T${time}`).toZonedDateTime('America/Chicago').epochMilliseconds;
    const saved = await call('PUT', '/calendars/phone/events', {
      events: [{ id: '1:1', calendarId: '7', begin: at('09:00'), end: at('10:00'), allDay: false, busy: true }],
    });
    expect(saved.json).toEqual({ saved: 1 });
    expect((await call('GET', `/events?start=${today}&end=${today}`)).json.events).toMatchObject([{ title: null, calendar: 'Mine' }]);
    expect((await call('GET', `/load?start=${today}&end=${today}`)).json.days[0]).toMatchObject({ eventMinutes: 60, events: 1 });
    const { calendars } = (await call('GET', '/calendars')).json;
    expect((await call('PATCH', `/calendars/${calendars[0].id}`, { counts: false })).json.calendars[0]).toMatchObject({ counts: false });
    expect((await call('DELETE', '/calendars/phone')).status).toBe(204);
    expect((await call('GET', '/calendars')).json).toMatchObject({ on: false, calendars: [] });
  });
});

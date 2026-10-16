import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAi } from './ai/client.ts';
import { openDatabase } from './db/index.ts';
import { createLocalApp, deviceConfig, isDeviceEmail } from './local.ts';
import { createLocalPush } from './notify/local-push.ts';
import type { PushMessage } from './notify/devices.ts';
import { drizzleOn, type Db } from './db/open.ts';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { applyMigrations } from './db/open.ts';
import { asBetterSqlite, openWasmCopy, WasmClient, wasmBytes } from './db/wasm.ts';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { serverSettings } from './db/schema.ts';
import type { CopyEngine } from './domain/copies.ts';
import { memoryFiles } from './lib/memory-files.ts';
import type { SyncService } from './sync/service.ts';

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

describe('a copy of everything on a device', () => {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  const newestMigration = (JSON.parse(fs.readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as { entries: { when: number }[] }).entries.at(-1)!.when;

  /** A device with copies, as the worker sets one up; `replaced` gets what a restore would put in place. */
  function device(sync?: SyncService) {
    const raw = new sqlite3.oo1.DB(':memory:', 'c');
    const db = drizzleOn(asBetterSqlite(new WasmClient(sqlite3, raw)));
    applyMigrations(db, readMigrationFiles({ migrationsFolder }));
    const files = memoryFiles();
    const replaced: Uint8Array[] = [];
    const engine: CopyEngine = { current: () => wasmBytes(sqlite3, raw), open: (bytes) => openWasmCopy(sqlite3, bytes), replace: async (bytes) => void replaced.push(bytes) };
    const config = deviceConfig('https://amble.example', '', 'America/Chicago');
    const app = createLocalApp({
      db,
      config,
      ai: createAi(config, db, fetch, { seal: (k) => k, open: (k) => k }),
      push: createLocalPush(db, async () => true),
      files,
      sync,
      copies: { engine, newestMigration },
    });
    const request = (path: string, init?: RequestInit) => app.request(`https://amble.example/api${path}`, init);
    const post = (path: string, body: unknown) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { db, files, replaced, request, post };
  }

  /** What's in a copy: its settings, its files table, and its tasks. */
  function look(bytes: Uint8Array) {
    const copy = openWasmCopy(sqlite3, bytes);
    try {
      const rows = <T>(sql: string) => copy.client.prepare(sql).all() as T[];
      const tables = rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => t.name);
      return {
        settings: Object.fromEntries(rows<{ key: string; value: string }>('SELECT key, value FROM server_settings').map((r) => [r.key, JSON.parse(r.value)])),
        files: tables.includes('amble_copy_files') ? rows<{ sha256: string }>('SELECT sha256 FROM amble_copy_files').map((f) => f.sha256) : null,
        tasks: rows<{ title: string }>('SELECT title FROM tasks').map((t) => t.title),
      };
    } finally {
      copy.close();
    }
  }

  it("saves everything but the device's sync sign-in and AI key, files included, and a new device starts from it", async () => {
    const old = device();
    await old.post('/device/start', { name: 'Sam' });
    const task = (await (await old.post('/tasks', { title: 'Water the plants' })).json()).task;
    const upload = await old.request(`/tasks/${task.id}/files?name=note.txt`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'two cups a week' });
    expect(upload.status).toBe(201);
    old.db.insert(serverSettings).values({ key: 'ai', value: { provider: 'anthropic', key: 'sk-old' } }).run();
    old.db.insert(serverSettings).values({ key: 'sync', value: { site: 'old-site', target: null, serverToken: 'old-token' } }).run();

    const saved = await old.request('/copy');
    expect(saved.headers.get('content-disposition')).toMatch(/^attachment; filename="amble-\d{4}-\d{2}-\d{2}\.amble"$/);
    const bytes = new Uint8Array(await saved.arrayBuffer());
    const inside = look(bytes);
    expect(Object.keys(inside.settings)).toContain('device');
    expect(inside.settings).not.toHaveProperty('ai');
    expect(inside.settings).not.toHaveProperty('sync');
    expect(inside.files).toEqual([...old.files.stored.keys()]);

    // A new phone, never set up, with its own identity and AI key.
    const fresh = device();
    fresh.db.insert(serverSettings).values({ key: 'ai', value: { provider: 'gemini', key: 'sk-new' } }).run();
    fresh.db.insert(serverSettings).values({ key: 'sync', value: { site: 'new-site', target: null } }).run();
    const restored = await fresh.request('/copy', { method: 'POST', body: bytes });
    expect(await restored.json()).toEqual({ restored: true });
    const now = look(fresh.replaced[0]!);
    expect(now.tasks).toEqual(['Water the plants']);
    expect(now.files).toBeNull();
    expect(now.settings.device).toEqual(inside.settings.device);
    expect(now.settings.sync).toMatchObject({ site: 'new-site' });
    expect(now.settings.ai).toMatchObject({ key: 'sk-new' });
    expect(new TextDecoder().decode(fresh.files.stored.get([...old.files.stored.keys()][0]!))).toBe('two cups a week');
  });

  it("won't restore over a device that syncs, or anything but a copy from this version of Amble or an older one", async () => {
    const old = device();
    await old.post('/device/start', { name: 'Sam' });
    const bytes = new Uint8Array(await (await old.request('/copy')).arrayBuffer());

    const syncing = device({ status: () => ({ on: true }), stamp: () => {} } as unknown as SyncService);
    const refused = await syncing.request('/copy', { method: 'POST', body: bytes });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/stop syncing on this device first/);

    const fresh = device();
    const restore = async (body: Uint8Array<ArrayBuffer>) => {
      const res = await fresh.request('/copy', { method: 'POST', body });
      return { status: res.status, error: ((await res.json()) as { error?: string }).error };
    };
    expect(await restore(new TextEncoder().encode('not a database at all'))).toEqual({ status: 400, error: "That file isn't a copy of Amble." });
    const other = new sqlite3.oo1.DB(':memory:', 'c');
    other.exec('CREATE TABLE notes (text TEXT)');
    expect(await restore(wasmBytes(sqlite3, other))).toEqual({ status: 400, error: "That file isn't a copy of Amble." });
    other.close();

    const newer = openWasmCopy(sqlite3, bytes);
    newer.client.exec(`UPDATE __drizzle_migrations SET created_at = ${newestMigration + 1} WHERE created_at = ${newestMigration}`);
    const fromNewer = newer.bytes();
    newer.close();
    expect((await restore(fromNewer)).error).toMatch(/newer version of Amble/);
    expect(fresh.replaced).toHaveLength(0);
  });
});

// Amble's server, run inside the app: the same API and domain code, on SQLite compiled to
// WebAssembly, with the database in the browser's private file system (the "opfs-sahpool" VFS,
// which needs no special headers). One tab at a time holds the database; a Web Lock decides which.
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { createEstimator } from '../../../server/ai/estimate.ts';
import { createBriefings } from '../../../server/ai/plan.ts';
import { createAi } from '../../../server/ai/client.ts';
import { applyMigrations, drizzleOn, migrationsFrom, type Db } from '../../../server/db/open.ts';
import { asBetterSqlite, WasmClient } from '../../../server/db/wasm.ts';
import { sweepFiles } from '../../../server/domain/files.ts';
import { every, startJobs } from '../../../server/jobs.ts';
import { createLocalApp, deviceAdopt, deviceConfig } from '../../../server/local.ts';
import { createLocalPush } from '../../../server/notify/local-push.ts';
import { createReminderSender } from '../../../server/notify/reminders.ts';
import type { PushMessage } from '../../../server/notify/devices.ts';
import { createSyncService } from '../../../server/sync/service.ts';
import journal from '../../../drizzle/meta/_journal.json';
import { createOpfsFiles } from './files.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

const sqlFiles = import.meta.glob('../../../drizzle/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const LOCK = 'almanac-device-database';
const DB_FILE = '/almanac.db';

const post = (message: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

let init: (value: Extract<ToWorker, { type: 'init' }>) => void;
const initialized = new Promise<Extract<ToWorker, { type: 'init' }>>((resolve) => (init = resolve));

/** Waits for the database lock; says "busy" while another tab has it. */
function holdLock(): Promise<void> {
  return new Promise((resolve, reject) => {
    const hold = () => {
      resolve();
      // Held for as long as this worker lives; the app ends the worker to hand the database over.
      return new Promise<void>(() => {});
    };
    navigator.locks
      .request(LOCK, { ifAvailable: true }, (lock) => {
        if (lock) return hold();
        post({ type: 'busy' });
        return navigator.locks.request(LOCK, hold);
      })
      .catch(reject);
  });
}

let notifyId = 0;
const notifying = new Map<number, (ok: boolean) => void>();
const showNotification = (message: PushMessage) =>
  new Promise<boolean>((resolve) => {
    const id = ++notifyId;
    notifying.set(id, resolve);
    post({ type: 'notify', id, message });
  });

async function openDb(sqlite3: Sqlite3Static): Promise<Db> {
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'almanac', initialCapacity: 6 });
  const raw = new pool.OpfsSAHPoolDb(DB_FILE);
  const client = new WasmClient(sqlite3, raw);
  client.pragma('foreign_keys = ON');
  const db = drizzleOn(asBetterSqlite(client));
  applyMigrations(db, await migrationsFrom(journal, (tag) => sqlFiles[`../../../drizzle/${tag}.sql`]!));
  return db;
}

async function start() {
  const { basePath, userAgent } = await initialized;
  // The server's dates run on Temporal, which Safari doesn't have yet.
  if (!('Temporal' in globalThis)) await import('temporal-polyfill/global');
  await holdLock();
  // Told where the .wasm file is, since the bundler renamed it.
  const load = sqlite3InitModule as unknown as (options: object) => Promise<Sqlite3Static>;
  const sqlite3 = await load({ locateFile: () => wasmUrl, print: () => {}, printErr: (s: string) => console.warn(s) });
  const db = await openDb(sqlite3);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const config = deviceConfig(self.location.origin, basePath, timezone);
  // The key is kept on the device as everything else is; it never leaves it except to the provider.
  // With none here, a device that syncs with the household's own server uses the server's model.
  let sync: ReturnType<typeof createSyncService> | undefined;
  const ai = createAi(config, db, (input, init) => fetch(input, init), { seal: (key) => key, open: (key) => key }, () => sync?.remoteAi() ?? null);
  const push = createLocalPush(db, showNotification);
  const files = await createOpfsFiles();
  // The newest migration this build has: another device's copy from a newer one can't be merged.
  const schema = journal.entries.at(-1)!.tag;
  sync = createSyncService({ db, schema, adopt: deviceAdopt(db, config) });
  const app = createLocalApp({ db, config, ai, push, files, sync });

  const estimator = createEstimator(db, ai, timezone);
  const briefings = createBriefings(db, ai, timezone);
  const reminders = createReminderSender(db, push, basePath);
  const changed = (n: unknown) => {
    if (typeof n === 'number' && n > 0) post({ type: 'changed' });
  };
  // What a background job changes gets its time for sync, like a request's changes.
  const timed = (run: () => Promise<unknown>) => async () => {
    try {
      return await run();
    } finally {
      sync.stamp();
    }
  };
  startJobs([
    { name: 'reminders', run: timed(() => reminders.run()) },
    { name: 'estimates', run: timed(async () => changed(await estimator.run())) },
    { name: 'briefings', run: timed(() => briefings.run()) },
    { name: 'file cleanup', run: timed(every(24 * 60 * 60 * 1000, () => sweepFiles(db, files))) },
  ]);
  return { app, origin: self.location.origin, basePath, userAgent };
}

const ready = start();
ready.then(
  () => post({ type: 'ready' }),
  (err: unknown) => {
    console.error('Amble could not open its database:', err);
    post({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  },
);

async function handle(message: Extract<ToWorker, { type: 'request' }>) {
  const { app, origin, basePath, userAgent } = await ready;
  const headers = new Headers(message.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
  const req = new Request(`${origin}${basePath}/api${message.path}`, {
    method: message.method,
    headers,
    body: message.method === 'GET' || message.method === 'HEAD' ? null : message.body,
  });
  try {
    const res = await app.fetch(req);
    const body = res.status === 204 || res.status === 304 ? null : await res.arrayBuffer();
    post({ type: 'response', id: message.id, status: res.status, headers: [...res.headers], body }, body ? [body] : []);
  } catch (err) {
    console.error('Request failed on the device:', err);
    const body = new TextEncoder().encode(JSON.stringify({ error: 'Something went wrong. Try again.' })).buffer as ArrayBuffer;
    post({ type: 'response', id: message.id, status: 500, headers: [['content-type', 'application/json']], body }, [body]);
  }
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'init') init(message);
  else if (message.type === 'request') void handle(message);
  else if (message.type === 'notified') {
    notifying.get(message.id)?.(message.ok);
    notifying.delete(message.id);
  }
});

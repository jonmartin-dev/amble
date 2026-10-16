// A copy of everything on a device, saved by hand to a file the person keeps, and put back from
// one: for a device that doesn't sync (whose only other backup is the phone's own), a new phone,
// or a household syncing through Google Drive, where photos and files on tasks stay on the device
// that added them. The copy is the whole database, with the files' bytes in a table of their own,
// and without this device's sync sign-in or AI key.
import type { Database } from 'better-sqlite3';
import type { FileStore } from './files.ts';

/** The parts of a database client the copies need: better-sqlite3's, or the WebAssembly one shaped like it. */
type Client = Pick<Database, 'prepare' | 'exec'>;

/** Turns whole databases into bytes and back: the device's WebAssembly SQLite, or better-sqlite3 in tests. */
export interface CopyEngine {
  /** This device's database as it is now. */
  current(): Uint8Array<ArrayBuffer>;
  /** A database of its own, in memory, from bytes; `bytes()` writes it back out. */
  open(bytes: Uint8Array): { client: Client; bytes(): Uint8Array<ArrayBuffer>; close(): void };
  /** Puts bytes in place of this device's database. Nothing can use the database after; the app starts again. */
  replace(bytes: Uint8Array): Promise<void>;
}

export class CopyError extends Error {}

/** Where the files' bytes travel in a copy. */
const FILES = 'amble_copy_files';
/** What belongs to this device and stays with it: its sync identity and sign-in, and its AI key. */
const DEVICE_ONLY = `key IN ('sync', 'ai')`;
const NOT_A_COPY = "That file isn't a copy of Amble.";
// A copy's files were within the limit when they were added; this only stops a damaged one.
const FILE_LIMIT = 1024 * 1024 * 1024;

/** A copy of this device to save: everything in it, photos and files on tasks included, but not its sync sign-in or AI key. */
export async function savedCopy(engine: CopyEngine, files: FileStore): Promise<Uint8Array<ArrayBuffer>> {
  const copy = engine.open(engine.current());
  try {
    copy.client.exec(`DELETE FROM server_settings WHERE ${DEVICE_ONLY}`);
    copy.client.exec(`CREATE TABLE ${FILES} (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL)`);
    const shas = copy.client.prepare(`SELECT sha256 AS sha FROM attachments UNION SELECT preview_sha256 FROM attachments WHERE preview_sha256 IS NOT NULL`).all() as { sha: string }[];
    const put = copy.client.prepare(`INSERT INTO ${FILES} (sha256, bytes) VALUES (?, ?)`);
    for (const { sha } of shas) {
      // A file another device added and this one never opened isn't here; the copy goes without it.
      const file = await files.get(sha);
      if (file) put.run(sha, await file.bytes());
    }
    copy.client.exec('VACUUM');
    return copy.bytes();
  } finally {
    copy.close();
  }
}

/**
 * Checks a saved copy and returns what to put in place of this device's database, after storing
 * the copy's files. The device stays itself: its sync identity and AI key carry over, not the
 * copy's. `newestMigration` is when this build's newest migration was written: a copy from a
 * newer Amble can't be opened here.
 */
export async function restoredCopy(engine: CopyEngine, files: FileStore, bytes: Uint8Array, newestMigration: number): Promise<Uint8Array<ArrayBuffer>> {
  const header = new TextDecoder().decode(bytes.subarray(0, 15));
  if (header !== 'SQLite format 3') throw new CopyError(NOT_A_COPY);
  let copy: ReturnType<CopyEngine['open']>;
  try {
    copy = engine.open(bytes);
  } catch {
    throw new CopyError(NOT_A_COPY);
  }
  try {
    const tables = new Set((copy.client.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name));
    if (!['members', 'tasks', 'server_settings', '__drizzle_migrations'].every((t) => tables.has(t))) throw new CopyError(NOT_A_COPY);
    const { at } = copy.client.prepare(`SELECT max(created_at) AS at FROM __drizzle_migrations`).get() as { at: number | null };
    if ((at ?? 0) > newestMigration) throw new CopyError('That copy is from a newer version of Amble. Update the app, then restore it.');

    if (tables.has(FILES)) {
      for (const { bytes: file } of copy.client.prepare(`SELECT bytes FROM ${FILES}`).all() as { bytes: Uint8Array }[]) {
        await files.save(new Blob([file as BlobPart]).stream(), FILE_LIMIT);
      }
      copy.client.exec(`DROP TABLE ${FILES}`);
    }

    const here = engine.open(engine.current());
    let mine: { key: string; value: string }[];
    try {
      mine = here.client.prepare(`SELECT key, value FROM server_settings WHERE ${DEVICE_ONLY}`).all() as { key: string; value: string }[];
    } finally {
      here.close();
    }
    copy.client.exec(`DELETE FROM server_settings WHERE ${DEVICE_ONLY}`);
    const put = copy.client.prepare(`INSERT INTO server_settings (key, value) VALUES (?, ?)`);
    for (const row of mine) put.run(row.key, row.value);
    copy.client.exec('VACUUM');
    return copy.bytes();
  } finally {
    copy.close();
  }
}

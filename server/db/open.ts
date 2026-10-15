// Drizzle over any SQLite that looks like better-sqlite3: the native one on the server, or the
// WebAssembly build in the app's worker (./wasm.ts). Migrations come in already read, since the
// worker has them bundled rather than on disk.
import type { Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export interface Migration {
  sql: string[];
  folderMillis: number;
  hash: string;
  bps: boolean;
}

export function drizzleOn(client: Database) {
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof drizzleOn>;

/** Applies the migrations a database hasn't had yet, in one transaction. */
export function applyMigrations(db: Db, migrations: Migration[]) {
  const { dialect, session } = db as unknown as { dialect: { migrate(m: Migration[], s: unknown, c: object): void }; session: unknown };
  dialect.migrate(migrations, session, {});
}

/** Migrations from drizzle-kit's files: the journal and each SQL file's text. */
export async function migrationsFrom(journal: { entries: { tag: string; when: number; breakpoints: boolean }[] }, sqlFor: (tag: string) => string) {
  const out: Migration[] = [];
  for (const entry of journal.entries) {
    const query = sqlFor(entry.tag);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    out.push({ sql: query.split('--> statement-breakpoint'), bps: entry.breakpoints, folderMillis: entry.when, hash });
  }
  return out;
}

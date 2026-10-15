import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { config } from '../config.ts';
import { applyMigrations, drizzleOn, type Migration } from './open.ts';
import { asBetterSqlite, WasmClient } from './wasm.ts';

export type { Db } from './open.ts';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

let migrations: Migration[] | undefined;

/** The newest migration: a copy written by a newer Amble than this can't be merged here. */
export const SCHEMA = (JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.at(-1)!.tag;

export function openDatabase(file = path.join(config.dataDir, 'almanac.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  // `AMBLE_SQLITE=wasm pnpm test` runs every test on the app's WebAssembly SQLite instead.
  const wasm = (globalThis as { __ambleSqlite3?: Sqlite3Static }).__ambleSqlite3;
  const sqlite = wasm && file === ':memory:' ? asBetterSqlite(new WasmClient(wasm, new wasm.oo1.DB(':memory:', 'c'))) : new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzleOn(sqlite);
  migrations ??= readMigrationFiles({ migrationsFolder });
  applyMigrations(db, migrations);
  return db;
}

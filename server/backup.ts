// Writes a transactionally consistent copy of the database for file-level backups to pick up.
// Usage (inside the container): node server/backup.ts  -> $AMBLE_DATA_DIR/snapshots/almanac-latest.db
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.ts';

const source = path.join(config.dataDir, 'almanac.db');
const dir = path.join(config.dataDir, 'snapshots');
const target = path.join(dir, 'almanac-latest.db');
const temp = `${target}.tmp`;

fs.mkdirSync(dir, { recursive: true });
fs.rmSync(temp, { force: true });
const db = new Database(source, { readonly: true });
await db.backup(temp);
db.close();
fs.renameSync(temp, target);
console.log(JSON.stringify({ ok: true, path: target, bytes: fs.statSync(target).size }));

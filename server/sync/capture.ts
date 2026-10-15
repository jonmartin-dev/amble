// Recording changes for sync. Triggers note each field of a synced row that changes (and each row
// that's removed) with no time yet; the app then stamps everything one request changed with a
// single clock reading. Working that way, nothing in the database calls back into JavaScript, so
// any process can write to it: the connector, a migration, the command-line tools.
import type { Db } from '../db/open.ts';
import type { Clock } from './hlc.ts';
import { SYNCED, type SyncedTable } from './tables.ts';

type Client = Db['$client'];

export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The row's key as JSON, the way sync_cells and sync_tombstones store it. */
export const pkExpr = (t: SyncedTable, alias?: string) => `json_array(${t.pk.map((c) => (alias ? `${alias}.${quote(c)}` : quote(c))).join(', ')})`;

/** The table's columns that sync, in the database's order. */
export function syncedColumns(client: Client, t: SyncedTable): string[] {
  const all = client.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as { name: string }[];
  return all.map((c) => c.name).filter((c) => !t.local?.includes(c));
}

const triggerNames = (t: SyncedTable) => ['ins', 'upd', 'del'].map((k) => `sync_${k}_${t.name}`);

function dropTriggers(client: Client) {
  for (const t of SYNCED) for (const name of triggerNames(t)) client.exec(`DROP TRIGGER IF EXISTS ${quote(name)}`);
}

function createTriggers(client: Client) {
  const when = `WHEN (SELECT "on" FROM sync_capture WHERE id = 1)`;
  for (const t of SYNCED) {
    const cols = syncedColumns(client, t);
    const [ins, upd, del] = triggerNames(t);
    const pkNew = pkExpr(t, 'NEW');
    const pkOld = pkExpr(t, 'OLD');
    const upsert = `ON CONFLICT(tbl, pk, col) DO UPDATE SET hlc = NULL`;
    client.exec(`CREATE TRIGGER ${quote(ins!)} AFTER INSERT ON ${quote(t.name)} ${when} BEGIN
      DELETE FROM sync_tombstones WHERE tbl = '${t.name}' AND pk = ${pkNew};
      INSERT INTO sync_cells (tbl, pk, col, hlc) VALUES ${cols.map((c) => `('${t.name}', ${pkNew}, '${c}', NULL)`).join(', ')} ${upsert};
    END`);
    client.exec(`CREATE TRIGGER ${quote(upd!)} AFTER UPDATE ON ${quote(t.name)} ${when} BEGIN
      ${cols.map((c) => `INSERT INTO sync_cells (tbl, pk, col, hlc) SELECT '${t.name}', ${pkNew}, '${c}', NULL WHERE OLD.${quote(c)} IS NOT NEW.${quote(c)} ${upsert};`).join('\n      ')}
    END`);
    client.exec(`CREATE TRIGGER ${quote(del!)} AFTER DELETE ON ${quote(t.name)} ${when} BEGIN
      DELETE FROM sync_cells WHERE tbl = '${t.name}' AND pk = ${pkOld};
      INSERT INTO sync_tombstones (tbl, pk, hlc) VALUES ('${t.name}', ${pkOld}, NULL) ON CONFLICT(tbl, pk) DO UPDATE SET hlc = NULL;
    END`);
  }
}

/** Whether this database records changes for sync. */
export function capturing(db: Db): boolean {
  const row = db.$client.prepare(`SELECT 1 AS on_ FROM sqlite_master WHERE type = 'trigger' AND name = 'sync_ins_tasks'`).get();
  return row != null;
}

/**
 * Starts recording changes, or brings the triggers up to date with the schema after a migration.
 * Rows from before sync was on count as older than any change since.
 */
export function startCapture(db: Db) {
  const client = db.$client;
  db.transaction(() => {
    client.exec(`INSERT INTO sync_capture (id, "on") VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET "on" = 1`);
    dropTriggers(client);
    createTriggers(client);
  });
}

/** Stops recording and forgets what was recorded, for turning sync off. */
export function stopCapture(db: Db) {
  const client = db.$client;
  db.transaction(() => {
    dropTriggers(client);
    client.exec(`DELETE FROM sync_capture; DELETE FROM sync_cells; DELETE FROM sync_tombstones;`);
  });
}

/** Turns recording off or on for a moment, while another device's changes go in. */
export function setRecording(db: Db, on: boolean) {
  db.$client.prepare(`UPDATE sync_capture SET "on" = ? WHERE id = 1`).run(on ? 1 : 0);
}

/** Gives every change not yet timed one clock reading. Returns how many fields and removals it timed. */
export function stamp(db: Db, clock: Clock): number {
  const client = db.$client;
  const pending =
    (client.prepare(`SELECT count(*) AS n FROM sync_cells WHERE hlc IS NULL`).get() as { n: number }).n +
    (client.prepare(`SELECT count(*) AS n FROM sync_tombstones WHERE hlc IS NULL`).get() as { n: number }).n;
  if (pending === 0) return 0;
  const hlc = clock.tick();
  client.prepare(`UPDATE sync_cells SET hlc = ? WHERE hlc IS NULL`).run(hlc);
  client.prepare(`UPDATE sync_tombstones SET hlc = ? WHERE hlc IS NULL`).run(hlc);
  return pending;
}

/** The latest reading in the database, so a restarted clock carries on after it. */
export function latestReading(db: Db): string | null {
  const row = db.$client.prepare(`SELECT max(h) AS h FROM (SELECT max(hlc) AS h FROM sync_cells UNION ALL SELECT max(hlc) FROM sync_tombstones)`).get() as {
    h: string | null;
  };
  return row.h;
}

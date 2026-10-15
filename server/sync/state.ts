// A household's state for sync: every synced row with the time each of its fields last changed,
// and the rows that were removed and when. Merging another copy's state takes, field by field,
// whichever change is later, so every copy that has seen the same changes ends up the same, in
// whatever order they arrive. A row is gone if its removal is later than every change to it.
import type { Db } from '../db/open.ts';
import { pkExpr, quote, setRecording, stamp, syncedColumns } from './capture.ts';
import { siteOf, type Clock } from './hlc.ts';
import { SYNCED, type SyncedTable } from './tables.ts';

type Client = Db['$client'];
type Value = string | number | null;

export interface TableState {
  cols: string[];
  /** [key, values in `cols` order, when each changed ('' for before sync)]. */
  rows: [string, Value[], string[]][];
  /** [key, when it was removed]. */
  dead: [string, string][];
}

export interface SyncState {
  v: 1;
  /** The newest migration the copy that wrote it had. */
  schema: string;
  /** Each device's latest change in here, so a device can tell whether its own changes made it in. */
  sites: Record<string, string>;
  tables: Record<string, TableState>;
}

export class NewerSchema extends Error {}

const max = (a: string | undefined, b: string | undefined) => ((a ?? '') > (b ?? '') ? (a ?? '') : (b ?? ''));

function cellsOf(client: Client, table: string) {
  const out = new Map<string, Map<string, string>>();
  for (const { pk, col, hlc } of client.prepare(`SELECT pk, col, hlc FROM sync_cells WHERE tbl = ?`).all(table) as { pk: string; col: string; hlc: string | null }[]) {
    let row = out.get(pk);
    if (!row) out.set(pk, (row = new Map()));
    row.set(col, hlc ?? '');
  }
  return out;
}

function tombstonesOf(client: Client, table: string) {
  return new Map(
    (client.prepare(`SELECT pk, hlc FROM sync_tombstones WHERE tbl = ?`).all(table) as { pk: string; hlc: string | null }[]).map((r) => [r.pk, r.hlc ?? ''] as const),
  );
}

function rowsOf(client: Client, t: SyncedTable, cols: string[]) {
  const out = new Map<string, Value[]>();
  const sql = `SELECT ${pkExpr(t)} AS __pk, ${cols.map(quote).join(', ')} FROM ${quote(t.name)}`;
  for (const r of client.prepare(sql).raw().all() as Value[][]) out.set(r[0] as string, r.slice(1));
  return out;
}

/** Everything this copy has, for writing out. Stamps changes still waiting for a time first. */
export function exportState(db: Db, clock: Clock, schema: string): SyncState {
  stamp(db, clock);
  const client = db.$client;
  return db.transaction(() => {
    const tables: Record<string, TableState> = {};
    const sites: Record<string, string> = {};
    const note = (hlc: string) => {
      if (!hlc) return;
      const site = siteOf(hlc);
      if ((sites[site] ?? '') < hlc) sites[site] = hlc;
    };
    for (const t of SYNCED) {
      const cols = syncedColumns(client, t);
      const cells = cellsOf(client, t.name);
      const rows: TableState['rows'] = [];
      for (const [pk, values] of rowsOf(client, t, cols)) {
        const times = cells.get(pk);
        const hlcs = cols.map((c) => times?.get(c) ?? '');
        hlcs.forEach(note);
        rows.push([pk, values, hlcs]);
      }
      const dead: TableState['dead'] = [];
      for (const [pk, hlc] of tombstonesOf(client, t.name)) {
        note(hlc);
        dead.push([pk, hlc]);
      }
      tables[t.name] = { cols, rows, dead };
    }
    return { v: 1, schema, sites, tables };
  });
}

/** Whose changes a state is missing: true if this device made a change it doesn't have yet. */
export function missingMine(db: Db, clock: Clock, remote: SyncState | null): boolean {
  stamp(db, clock);
  const mine = db.$client
    .prepare(
      `SELECT max(h) AS h FROM (SELECT max(hlc) AS h FROM sync_cells WHERE substr(hlc, -${clock.site.length}) = ? UNION ALL SELECT max(hlc) FROM sync_tombstones WHERE substr(hlc, -${clock.site.length}) = ?)`,
    )
    .get(clock.site, clock.site) as { h: string | null };
  if (!mine.h) return remote == null;
  return (remote?.sites[clock.site] ?? '') < mine.h;
}

const where = (t: SyncedTable) => t.pk.map((c) => `${quote(c)} = ?`).join(' AND ');

export interface MergeResult {
  /** Rows added, changed or removed here. */
  changed: number;
}

/**
 * Takes in another copy's state. Fields and removals that are later than this copy's win; the
 * rest stay. Afterwards, references to rows that are gone are settled the way the schema says
 * (cleared, or removed with them), and the few rules that span rows are put right again.
 */
export function mergeState(db: Db, clock: Clock, remote: SyncState, schema: string): MergeResult {
  if (remote.schema > schema) throw new NewerSchema(`That copy was written by a newer Almanac (${remote.schema}).`);
  // Local changes get their times first, so they can be weighed against the incoming ones.
  stamp(db, clock);
  const client = db.$client;
  let changed = 0;
  db.transaction(() => {
    client.exec('PRAGMA defer_foreign_keys = ON');
    setRecording(db, false);
    try {
      for (const t of SYNCED) {
        const theirs = remote.tables[t.name];
        if (!theirs) continue;
        changed += mergeTable(client, t, theirs);
      }
    } finally {
      setRecording(db, true);
    }
    // Settling references and rules is this copy's own change, so it's recorded like one.
    settleReferences(client);
    reconcile(client);
    for (const t of SYNCED) {
      client.prepare(`DELETE FROM sync_cells WHERE tbl = ? AND pk NOT IN (SELECT ${pkExpr(t)} FROM ${quote(t.name)})`).run(t.name);
    }
  });
  for (const hlc of Object.values(remote.sites)) clock.see(hlc);
  stamp(db, clock);
  return { changed };
}

function mergeTable(client: Client, t: SyncedTable, theirs: TableState): number {
  const cols = syncedColumns(client, t);
  const known = new Set(cols);
  const local = rowsOf(client, t, cols);
  const cells = cellsOf(client, t.name);
  const tombs = tombstonesOf(client, t.name);
  const theirDead = new Map(theirs.dead);
  const upsertCell = client.prepare(`INSERT INTO sync_cells (tbl, pk, col, hlc) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, pk, col) DO UPDATE SET hlc = excluded.hlc`);
  const upsertTomb = client.prepare(`INSERT INTO sync_tombstones (tbl, pk, hlc) VALUES (?, ?, ?) ON CONFLICT(tbl, pk) DO UPDATE SET hlc = excluded.hlc`);
  const dropTomb = client.prepare(`DELETE FROM sync_tombstones WHERE tbl = ? AND pk = ?`);
  const dropCells = client.prepare(`DELETE FROM sync_cells WHERE tbl = ? AND pk = ?`);
  const remove = client.prepare(`DELETE FROM ${quote(t.name)} WHERE ${where(t)}`);
  let changed = 0;

  const kill = (pk: string, hlc: string) => {
    if (local.has(pk)) {
      remove.run(...(JSON.parse(pk) as Value[]));
      changed++;
    }
    dropCells.run(t.name, pk);
    upsertTomb.run(t.name, pk, hlc);
  };

  for (const [pk, values, hlcs] of theirs.rows) {
    const mine = cells.get(pk);
    const tomb = max(tombs.get(pk), theirDead.get(pk));
    // The later of each field.
    const wins: { col: string; value: Value; hlc: string }[] = [];
    let latest = '';
    theirs.cols.forEach((col, i) => {
      if (!known.has(col)) return;
      const ours = mine?.get(col) ?? '';
      const theirsAt = hlcs[i] ?? '';
      latest = max(latest, max(ours, theirsAt));
      if (theirsAt > ours || (!local.has(pk) && theirsAt >= ours)) wins.push({ col, value: values[i] ?? null, hlc: theirsAt });
    });
    for (const hlc of mine?.values() ?? []) latest = max(latest, hlc);
    // A removal wins only if it's later than every change; the same moment is a row kept.
    const alive = !tomb || latest >= tomb;
    if (!alive) {
      kill(pk, tomb);
      continue;
    }
    if (local.has(pk)) {
      if (wins.length === 0) continue;
      const extra = t.name === 'reminders' && wins.some((w) => w.col === 'fire_at') ? `, sent_at = NULL, outcome = NULL` : '';
      client
        .prepare(`UPDATE ${quote(t.name)} SET ${wins.map((w) => `${quote(w.col)} = ?`).join(', ')}${extra} WHERE ${where(t)}`)
        .run(...wins.map((w) => w.value), ...(JSON.parse(pk) as Value[]));
    } else {
      const present = theirs.cols.filter((c) => known.has(c));
      const byCol = new Map(theirs.cols.map((c, i) => [c, values[i] ?? null]));
      client.prepare(`INSERT INTO ${quote(t.name)} (${present.map(quote).join(', ')}) VALUES (${present.map(() => '?').join(', ')})`).run(...present.map((c) => byCol.get(c)!));
      if (tombs.has(pk)) dropTomb.run(t.name, pk);
    }
    changed++;
    for (const w of wins) if (w.hlc) upsertCell.run(t.name, pk, w.col, w.hlc);
  }

  // Removals of rows they no longer have at all.
  const theirRows = new Set(theirs.rows.map((r) => r[0]));
  for (const [pk, hlc] of theirs.dead) {
    if (theirRows.has(pk)) continue;
    let latest = '';
    for (const at of cells.get(pk)?.values() ?? []) latest = max(latest, at);
    if (local.has(pk) && latest >= hlc) continue;
    if ((tombs.get(pk) ?? '') >= hlc && !local.has(pk)) continue;
    kill(pk, max(hlc, tombs.get(pk)));
  }
  return changed;
}

/**
 * A row can arrive pointing at one another device removed. Each reference is settled as its
 * foreign key says: cleared (ON DELETE SET NULL) or removed along with it.
 */
function settleReferences(client: Client) {
  for (let pass = 0; pass < 10; pass++) {
    const broken = client.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number; parent: string; fkid: number }[];
    if (broken.length === 0) return;
    const keys = new Map<string, { id: number; from: string; on_delete: string }[]>();
    for (const b of broken) {
      if (!keys.has(b.table)) keys.set(b.table, client.prepare(`PRAGMA foreign_key_list(${quote(b.table)})`).all() as { id: number; from: string; on_delete: string }[]);
      const fk = keys.get(b.table)!.filter((k) => k.id === b.fkid);
      if (fk[0]?.on_delete === 'SET NULL') {
        client.prepare(`UPDATE ${quote(b.table)} SET ${fk.map((k) => `${quote(k.from)} = NULL`).join(', ')} WHERE rowid = ?`).run(b.rowid);
      } else client.prepare(`DELETE FROM ${quote(b.table)} WHERE rowid = ?`).run(b.rowid);
    }
  }
}

/**
 * Rules that span rows, which two devices can each keep while breaking them together: a repeating
 * task has one open task at a time, and a list has one of each item still to get. The earliest
 * stays; every device picks the same one.
 */
function reconcile(client: Client) {
  const extraRepeats = client
    .prepare(
      `SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY series_id ORDER BY created_at, id) AS n FROM tasks WHERE status = 'open' AND series_id IS NOT NULL) WHERE n > 1`,
    )
    .all() as { id: string }[];
  for (const { id } of extraRepeats) client.prepare(`UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?`).run(Date.now(), id);

  const extraItems = client
    .prepare(
      `SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY group_id, lower(trim(name)) ORDER BY created_at, id) AS n FROM list_items WHERE checked_at IS NULL) WHERE n > 1`,
    )
    .all() as { id: string }[];
  for (const { id } of extraItems) client.prepare(`DELETE FROM list_items WHERE id = ?`).run(id);
}

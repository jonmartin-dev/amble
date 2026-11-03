// A household's state for sync: every synced row with the time each of its fields last changed,
// and the rows that were removed and when. Merging another copy's state takes, field by field,
// whichever change is later, so every copy that has seen the same changes ends up the same, in
// whatever order they arrive. A row is gone if its removal is later than every change to it.
import type { Db } from '../db/open.ts';
import { pkExpr, quote, setRecording, stamp, syncedColumns } from './capture.ts';
import { SITE_LENGTH, siteOf, type Clock } from './hlc.ts';
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
  /** Rows folded into others: [table, the one that went, the one that stayed]. */
  aliases?: [string, string, string][];
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
    const aliases = client.prepare(`SELECT tbl, from_pk, to_pk FROM sync_aliases`).raw().all() as [string, string, string][];
    return { v: 1, schema, sites, tables, aliases };
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

/**
 * Whether this copy has any change another copy lacks, its own or one it took in from elsewhere: for
 * a device carrying changes between two places (the household's server, and the Drive file the
 * household is moving from), where missingMine would only see its own.
 */
export function missingAny(db: Db, clock: Clock, remote: SyncState | null): boolean {
  stamp(db, clock);
  const latest = db.$client
    .prepare(
      `SELECT site, max(h) AS h FROM (SELECT substr(hlc, -${SITE_LENGTH}) AS site, hlc AS h FROM sync_cells UNION ALL SELECT substr(hlc, -${SITE_LENGTH}), hlc FROM sync_tombstones) GROUP BY site`,
    )
    .all() as { site: string; h: string }[];
  if (!latest.length) return remote == null;
  return latest.some((l) => (remote?.sites[l.site] ?? '') < l.h);
}

const where = (t: SyncedTable) => t.pk.map((c) => `${quote(c)} = ?`).join(' AND ');

export interface MergeResult {
  /** Rows added, changed or removed here. */
  changed: number;
}

/**
 * Takes in another copy's state. Fields and removals that are later than this copy's win; the
 * rest stay. Two rows that are really one (the same email on two people) become one, the same way
 * on every copy. Afterwards, references to rows that are gone move to the row that took their
 * place, or are settled the way the schema says (cleared, or removed with them), and the few rules
 * that span rows are put right again.
 */
export function mergeState(db: Db, clock: Clock, remote: SyncState, schema: string): MergeResult {
  if (remote.schema > schema) throw new NewerSchema(`That copy was written by a newer Amble (${remote.schema}).`);
  // Local changes get their times first, so they can be weighed against the incoming ones.
  stamp(db, clock);
  for (const hlc of Object.values(remote.sites)) clock.see(hlc);
  const client = db.$client;
  let changed = 0;
  // References are settled by hand below, so a removal arriving here doesn't clear them first.
  // (SQLite only changes this outside a transaction.)
  const enforced = !client.inTransaction;
  if (enforced) client.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const addAlias = client.prepare(`INSERT OR IGNORE INTO sync_aliases (tbl, from_pk, to_pk) VALUES (?, ?, ?)`);
      for (const [tbl, from, to] of remote.aliases ?? []) addAlias.run(tbl, from, to);
      const record = (on: boolean) => setRecording(db, on);
      record(false);
      try {
        for (const t of SYNCED) {
          const theirs = remote.tables[t.name];
          if (!theirs) continue;
          changed += mergeTable(client, t, theirs, record);
        }
      } finally {
        record(true);
      }
      // Whatever this copy does to settle things is its own change, so it's recorded like one.
      followAliases(client);
      settleReferences(client);
      reconcile(client);
      for (const t of SYNCED) {
        client.prepare(`DELETE FROM sync_cells WHERE tbl = ? AND pk NOT IN (SELECT ${pkExpr(t)} FROM ${quote(t.name)})`).run(t.name);
      }
    });
  } finally {
    if (enforced) client.pragma('foreign_keys = ON');
  }
  stamp(db, clock);
  return { changed };
}

/** The table's unique column sets other than its primary key, like members' email. */
function uniqueSets(client: Client, table: string): string[][] {
  const indexes = client.prepare(`PRAGMA index_list(${quote(table)})`).all() as { name: string; unique: number; origin: string }[];
  return indexes
    .filter((i) => i.unique && i.origin !== 'pk')
    .map((i) => (client.prepare(`PRAGMA index_info(${quote(i.name)})`).all() as { name: string }[]).map((c) => c.name));
}

function mergeTable(client: Client, t: SyncedTable, theirs: TableState, record: (on: boolean) => void): number {
  const cols = syncedColumns(client, t);
  const known = new Set(cols);
  const local = rowsOf(client, t, cols);
  const cells = cellsOf(client, t.name);
  const tombs = tombstonesOf(client, t.name);
  const theirDead = new Map(theirs.dead);
  const folded = new Set((client.prepare(`SELECT from_pk FROM sync_aliases WHERE tbl = ?`).all(t.name) as { from_pk: string }[]).map((a) => a.from_pk));
  const uniques = uniqueSets(client, t.name);
  const upsertCell = client.prepare(`INSERT INTO sync_cells (tbl, pk, col, hlc) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, pk, col) DO UPDATE SET hlc = excluded.hlc`);
  const upsertTomb = client.prepare(`INSERT INTO sync_tombstones (tbl, pk, hlc) VALUES (?, ?, ?) ON CONFLICT(tbl, pk) DO UPDATE SET hlc = excluded.hlc`);
  const dropTomb = client.prepare(`DELETE FROM sync_tombstones WHERE tbl = ? AND pk = ?`);
  const dropCells = client.prepare(`DELETE FROM sync_cells WHERE tbl = ? AND pk = ?`);
  const remove = client.prepare(`DELETE FROM ${quote(t.name)} WHERE ${where(t)}`);
  const addAlias = client.prepare(`INSERT OR REPLACE INTO sync_aliases (tbl, from_pk, to_pk) VALUES (?, ?, ?)`);
  let changed = 0;

  const kill = (pk: string, hlc: string) => {
    if (local.has(pk)) {
      remove.run(...(JSON.parse(pk) as Value[]));
      local.delete(pk);
      changed++;
    }
    dropCells.run(t.name, pk);
    upsertTomb.run(t.name, pk, hlc);
  };

  /** A local row other than `pk` that the incoming one would clash with on a unique field. */
  const clashWith = (pk: string, byCol: Map<string, Value>) => {
    for (const set of uniques) {
      const values = set.map((c) => byCol.get(c));
      // NULLs never clash in a unique index.
      if (values.some((v) => v == null)) continue;
      const row = client
        .prepare(`SELECT ${pkExpr(t)} AS pk FROM ${quote(t.name)} WHERE ${set.map((c) => `${quote(c)} = ?`).join(' AND ')} AND ${pkExpr(t)} != ?`)
        .get(...(values as Value[]), pk) as { pk: string } | undefined;
      if (row) return row.pk;
    }
    return null;
  };

  for (const [pk, values, hlcs] of theirs.rows) {
    // Folded into another row already: it lives on as that one.
    if (folded.has(pk)) continue;
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
      const clash = clashWith(pk, byCol);
      if (clash) {
        // The same thing made twice: every copy keeps the smaller key and folds the other into it.
        const keep = pk < clash ? pk : clash;
        addAlias.run(t.name, keep === pk ? clash : pk, keep);
        if (keep === clash) continue;
        // Theirs stays, so ours goes; that removal is this copy's change, for the others to hear.
        record(true);
        remove.run(...(JSON.parse(clash) as Value[]));
        record(false);
        local.delete(clash);
      }
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

/** Foreign keys pointing at a table, as [child table, its column]. Single-column keys only. */
function referencesTo(client: Client, parent: string) {
  const out: [string, string][] = [];
  const tables = client.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  for (const { name } of tables) {
    for (const k of client.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as { table: string; from: string; seq: number }[]) {
      if (k.table === parent && k.seq === 0) out.push([name, k.from]);
    }
  }
  return out;
}

/** Moves everything that points at a folded row onto the one that took its place, then removes it. */
function followAliases(client: Client) {
  const aliases = client.prepare(`SELECT tbl, from_pk, to_pk FROM sync_aliases`).all() as { tbl: string; from_pk: string; to_pk: string }[];
  for (const { tbl, from_pk, to_pk } of aliases) {
    const t = SYNCED.find((s) => s.name === tbl);
    if (!t || t.pk.length !== 1) continue;
    const [from] = JSON.parse(from_pk) as Value[];
    const [to] = JSON.parse(to_pk) as Value[];
    for (const [child, col] of referencesTo(client, tbl)) {
      // A row that would clash where it lands (the same day, a reminder on the same task) gives way.
      client.prepare(`UPDATE OR IGNORE ${quote(child)} SET ${quote(col)} = ? WHERE ${quote(col)} = ?`).run(to, from);
      client.prepare(`DELETE FROM ${quote(child)} WHERE ${quote(col)} = ?`).run(from);
    }
    client.prepare(`DELETE FROM ${quote(tbl)} WHERE ${where(t)}`).run(from);
  }
}

/**
 * A row can arrive pointing at one another device removed or folded. Each reference moves to the
 * row that took its place if there is one; otherwise it's settled as its foreign key says: cleared
 * (ON DELETE SET NULL) or removed along with it.
 */
function settleReferences(client: Client) {
  for (let pass = 0; pass < 10; pass++) {
    const broken = client.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number; parent: string; fkid: number }[];
    if (broken.length === 0) return;
    const keys = new Map<string, { id: number; from: string; on_delete: string }[]>();
    for (const b of broken) {
      if (!keys.has(b.table)) keys.set(b.table, client.prepare(`PRAGMA foreign_key_list(${quote(b.table)})`).all() as { id: number; from: string; on_delete: string }[]);
      const fk = keys.get(b.table)!.filter((k) => k.id === b.fkid);
      if (fk.length === 1) {
        const value = (client.prepare(`SELECT ${quote(fk[0]!.from)} AS v FROM ${quote(b.table)} WHERE rowid = ?`).get(b.rowid) as { v: Value } | undefined)?.v;
        const alias = client.prepare(`SELECT to_pk FROM sync_aliases WHERE tbl = ? AND from_pk = json_array(?)`).get(b.parent, value) as { to_pk: string } | undefined;
        if (alias) {
          const [to] = JSON.parse(alias.to_pk) as Value[];
          client.prepare(`UPDATE OR IGNORE ${quote(b.table)} SET ${quote(fk[0]!.from)} = ? WHERE rowid = ?`).run(to, b.rowid);
          client.prepare(`DELETE FROM ${quote(b.table)} WHERE rowid = ? AND ${quote(fk[0]!.from)} = ?`).run(b.rowid, value);
          continue;
        }
      }
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

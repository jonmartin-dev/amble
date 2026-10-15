// SQLite compiled to WebAssembly, made to look like better-sqlite3 so drizzle and every domain
// function run on it unchanged. The app uses it in a worker, on a database kept in the browser's
// private file system (web/src/worker/); tests use it in memory to check it behaves like the server's.
import type { Database as BetterDatabase } from 'better-sqlite3';
import type { BindingSpec, Database as WasmDatabase, PreparedStatement, SqlValue, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

type Row = Record<string, SqlValue>;
type Params = unknown[];

/** Prepared statements kept for reuse: drizzle prepares one on every query. */
const CACHE_SIZE = 200;

function bindable(params: Params): BindingSpec | undefined {
  if (params.length === 0) return undefined;
  // better-sqlite3 takes either positional values or one array of them.
  const list = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
  return list.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.getTime();
    return v;
  }) as BindingSpec;
}

class Statement {
  private readonly db: WasmClient;
  readonly source: string;
  private readonly rawMode: boolean;

  constructor(db: WasmClient, source: string, rawMode = false) {
    this.db = db;
    this.source = source;
    this.rawMode = rawMode;
  }

  /** Arrays of values instead of objects, like better-sqlite3's `raw()`. */
  raw(on = true) {
    return new Statement(this.db, this.source, on);
  }

  run(...params: Params) {
    return this.db.use(this.source, params, (stmt) => {
      while (stmt.step()) {
        // Statements with RETURNING run to the end even when nobody reads the rows.
      }
      return this.db.result();
    });
  }

  all(...params: Params) {
    return this.db.use(this.source, params, (stmt) => {
      const rows: (Row | SqlValue[])[] = [];
      while (stmt.step()) rows.push(this.rawMode ? stmt.get([]) : stmt.get({}));
      return rows;
    });
  }

  get(...params: Params) {
    return this.db.use(this.source, params, (stmt) => {
      if (!stmt.step()) return undefined;
      return this.rawMode ? stmt.get([]) : stmt.get({});
    });
  }
}

/** The parts of better-sqlite3's Database that drizzle and Almanac use. */
export class WasmClient {
  private readonly cache = new Map<string, { stmt: PreparedStatement; busy: boolean }>();
  private savepoints = 0;

  readonly sqlite3: Sqlite3Static;
  readonly db: WasmDatabase;

  constructor(sqlite3: Sqlite3Static, db: WasmDatabase) {
    this.sqlite3 = sqlite3;
    this.db = db;
  }

  prepare(source: string) {
    return new Statement(this, source);
  }

  /** Runs one statement with its values bound, reusing a prepared copy when one is free. */
  use<T>(source: string, params: Params, fn: (stmt: PreparedStatement) => T): T {
    let entry = this.cache.get(source);
    let own = false;
    if (!entry || entry.busy) {
      // A statement already running (a function called from SQL running the same query) gets a copy.
      const stmt = this.db.prepare(source);
      if (entry) own = true;
      else {
        entry = { stmt, busy: false };
        this.cache.set(source, entry);
        if (this.cache.size > CACHE_SIZE) this.evict();
      }
      if (own) entry = { stmt, busy: false };
    } else {
      // Most recently used last.
      this.cache.delete(source);
      this.cache.set(source, entry);
    }
    const { stmt } = entry;
    entry.busy = true;
    try {
      const binding = bindable(params);
      if (binding !== undefined) stmt.bind(binding);
      return fn(stmt);
    } finally {
      entry.busy = false;
      if (own) stmt.finalize();
      else stmt.reset(true);
    }
  }

  private evict() {
    for (const [source, entry] of this.cache) {
      if (entry.busy) continue;
      entry.stmt.finalize();
      this.cache.delete(source);
      return;
    }
  }

  /** What better-sqlite3's run() returns. */
  result() {
    return {
      changes: Number(this.db.changes()),
      lastInsertRowid: Number(this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer!)),
    };
  }

  get inTransaction() {
    return this.sqlite3.capi.sqlite3_get_autocommit(this.db.pointer!) === 0;
  }

  exec(source: string) {
    this.db.exec(source);
    return this;
  }

  pragma(source: string, options?: { simple?: boolean }) {
    const rows = this.prepare(`PRAGMA ${source}`).all() as Row[];
    if (options?.simple) return rows[0] ? Object.values(rows[0])[0] : undefined;
    return rows;
  }

  /** A JavaScript function SQL can call, like better-sqlite3's `function()`. */
  function(name: string, options: { deterministic?: boolean; varargs?: boolean } | ((...args: SqlValue[]) => SqlValue), fn?: (...args: SqlValue[]) => SqlValue) {
    const impl = typeof options === 'function' ? options : fn!;
    const opts = typeof options === 'function' ? {} : options;
    this.db.createFunction({
      name,
      xFunc: (_ctx: number, ...args: SqlValue[]) => impl(...args),
      deterministic: opts.deterministic ?? false,
      ...(opts.varargs ? { arity: -1 } : { arity: impl.length }),
    });
    return this;
  }

  /**
   * better-sqlite3's transaction(): BEGIN, run, COMMIT, or ROLLBACK if it throws. Inside another
   * transaction it uses a savepoint instead.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const run = (begin: string) => (...args: A): R => {
      const nested = this.inTransaction;
      const name = `almanac_sp_${++this.savepoints}`;
      this.db.exec(nested ? `SAVEPOINT ${name}` : begin);
      try {
        const result = fn(...args);
        if (result instanceof Promise) throw new TypeError('Transaction function cannot return a promise');
        this.db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        if (nested) {
          this.db.exec(`ROLLBACK TO ${name}`);
          this.db.exec(`RELEASE ${name}`);
        } else if (this.inTransaction) this.db.exec('ROLLBACK');
        throw err;
      }
    };
    return Object.assign(run('BEGIN'), {
      deferred: run('BEGIN DEFERRED'),
      immediate: run('BEGIN IMMEDIATE'),
      exclusive: run('BEGIN EXCLUSIVE'),
    });
  }

  close() {
    for (const { stmt } of this.cache.values()) stmt.finalize();
    this.cache.clear();
    this.db.close();
  }
}

/** The client typed as better-sqlite3, which is all drizzle needs to know. */
export const asBetterSqlite = (client: WasmClient) => client as unknown as BetterDatabase;

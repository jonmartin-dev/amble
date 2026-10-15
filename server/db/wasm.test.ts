import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from './index.ts';
import { drizzleOn } from './open.ts';
import { groups, members } from './schema.ts';
import { asBetterSqlite, WasmClient } from './wasm.ts';

let sqlite3: Sqlite3Static;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

const client = () => new WasmClient(sqlite3, new sqlite3.oo1.DB(':memory:', 'c'));

describe('the WebAssembly SQLite client', () => {
  it('answers run, get, all and raw the way better-sqlite3 does', () => {
    const c = client();
    c.exec('create table t (id integer primary key, name text, flag integer)');
    expect(c.prepare('insert into t (name, flag) values (?, ?)').run('a', true)).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(c.prepare('insert into t (name, flag) values (?, ?)').run(['b', false])).toEqual({ changes: 1, lastInsertRowid: 2 });
    expect(c.prepare('update t set flag = 1').run().changes).toBe(2);
    expect(c.prepare('select * from t where id = ?').get(2)).toEqual({ id: 2, name: 'b', flag: 1 });
    expect(c.prepare('select * from t where id = ?').get(9)).toBeUndefined();
    expect(c.prepare('select name from t order by id').all()).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(c.prepare('select id, name from t order by id').raw().all()).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    // RETURNING rows come back from get() and still count as written.
    expect(c.prepare("insert into t (name) values ('c') returning id").get()).toEqual({ id: 3 });
    expect(c.pragma('user_version', { simple: true })).toBe(0);
  });

  it('commits, rolls back and nests transactions as savepoints', () => {
    const c = client();
    c.exec('create table t (n integer)');
    const add = (n: number) => c.prepare('insert into t values (?)').run(n);
    c.transaction(() => add(1))();
    expect(() =>
      c.transaction(() => {
        add(2);
        throw new Error('no');
      })(),
    ).toThrow('no');
    c.transaction(() => {
      add(3);
      try {
        c.transaction(() => {
          add(4);
          throw new Error('inner');
        }).immediate();
      } catch {
        // The inner one is undone; the outer carries on.
      }
      add(5);
    }).deferred();
    expect(c.prepare('select n from t order by n').raw().all().flat()).toEqual([1, 3, 5]);
    expect(c.inTransaction).toBe(false);
  });

  it('runs functions defined in JavaScript', () => {
    const c = client();
    let n = 0;
    c.function('almanac_next', () => ++n);
    expect(c.prepare('select almanac_next() as a, almanac_next() as b').get()).toEqual({ a: 1, b: 2 });
  });

  it('carries drizzle and the migrations', () => {
    const db = drizzleOn(asBetterSqlite(client()));
    db.run(sql`create table g (id text primary key, name text not null, archived integer)`);
    const db2 = (globalThis as { __almanacSqlite3?: unknown }).__almanacSqlite3 ? openDatabase(':memory:') : null;
    // Under ALMANAC_SQLITE=wasm the whole suite's databases are this client too.
    if (db2) expect(db2.$client).toBeInstanceOf(WasmClient);
    const real = openDatabase(':memory:');
    const jon = real.insert(members).values({ email: 'jon@example.com', name: 'Jon', timezone: 'America/Chicago' }).returning().get();
    expect(jon).toMatchObject({ email: 'jon@example.com', showStreaks: true, theme: null });
    expect(jon.createdAt).toBeInstanceOf(Date);
    real.insert(groups).values({ name: 'Home', sections: ['a', 'b'] }).run();
    expect(real.select().from(groups).where(eq(groups.name, 'Home')).get()?.sections).toEqual(['a', 'b']);
  });
});

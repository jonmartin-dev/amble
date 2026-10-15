// Vitest setup for `ALMANAC_SQLITE=wasm pnpm test`: every in-memory database the tests open runs
// on the WebAssembly SQLite the app uses on the device, so the whole suite checks it too.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

(globalThis as { __almanacSqlite3?: unknown }).__almanacSqlite3 = await sqlite3InitModule();

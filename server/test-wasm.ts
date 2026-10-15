// Vitest setup for `AMBLE_SQLITE=wasm pnpm test`: every in-memory database the tests open runs
// on the WebAssembly SQLite the app uses on the device, so the whole suite checks it too.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

(globalThis as { __ambleSqlite3?: unknown }).__ambleSqlite3 = await sqlite3InitModule();

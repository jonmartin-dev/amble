// Stands in for better-sqlite3, which drizzle's driver imports but the device never runs: its
// database is SQLite in WebAssembly (server/db/wasm.ts).
export default class NoNativeSqlite {
  constructor() {
    throw new Error('Native SQLite is not available on a device.');
  }
}

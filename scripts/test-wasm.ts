// Runs the whole test suite on the WebAssembly SQLite that the device app uses (server/db/wasm.ts).
import { spawn } from 'node:child_process';

const child = spawn('pnpm', ['exec', 'vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ALMANAC_SQLITE: 'wasm' },
});
child.on('exit', (code) => process.exit(code ?? 1));

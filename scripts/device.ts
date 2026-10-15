// The app that runs Almanac on the device, with no server: `node scripts/device.ts dev` serves it
// on port 5174, and `node scripts/device.ts build` writes static files to dist/device.
// ALMANAC_BASE sets the path it's served under (default "/").
import { spawn } from 'node:child_process';

const [command = 'dev', ...rest] = process.argv.slice(2);
const args = command === 'build' ? ['build', ...rest] : ['--port', '5174', ...rest];
const child = spawn('pnpm', ['exec', 'vite', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_ALMANAC_DEVICE: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));

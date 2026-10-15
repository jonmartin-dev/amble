// The app that runs Almanac on the device, with no server: `node scripts/device.ts dev` serves it
// on port 5174, and `node scripts/device.ts build` writes static files to dist/device.
// ALMANAC_BASE sets the path it's served under (default "/").
import { spawn } from 'node:child_process';

const [command = 'dev', ...rest] = process.argv.slice(2);
// On 127.0.0.1 so http://127.0.0.1:5174 works as well as localhost: two addresses are two
// separate sites to the browser, which is handy for trying sync between two "devices".
const args = command === 'build' ? ['build', ...rest] : ['--port', '5174', '--host', '127.0.0.1', ...rest];
const child = spawn('pnpm', ['exec', 'vite', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_ALMANAC_DEVICE: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));

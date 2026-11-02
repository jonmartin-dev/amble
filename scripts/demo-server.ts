// Serves the built app on a demo household at http://localhost:8787, the same way on every OS. Makes
// the household in .demo/ the first time and builds the app if there's no build yet; run pnpm build
// after changing the app, and delete .demo/ to start the household over.
// Usage: pnpm demo [email]   (sam@example.com by default, the email the browser scripts sign in as)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const email = process.argv[2] ?? 'sam@example.com';
const dir = '.demo';
if (!fs.existsSync(`${dir}/almanac.db`)) execFileSync(process.execPath, ['scripts/demo.ts', dir, email], { stdio: 'inherit' });
// pnpm is a .cmd file on Windows, which only a shell runs.
if (!fs.existsSync('dist/web/index.html')) execFileSync('pnpm', ['build'], { stdio: 'inherit', shell: process.platform === 'win32' });

// Over anything .env sets for development, before the server reads its settings.
Object.assign(process.env, { AMBLE_DATA_DIR: dir, AMBLE_PUBLIC_URL: 'http://localhost:8787', PORT: '8787', AMBLE_DEV_LOGIN: '1' });
console.log(`Open http://localhost:8787, choose Use my own server, and sign in as ${email}.`);
await import('../server/index.ts');

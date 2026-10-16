import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { build, type Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

const server = `http://localhost:${process.env.PORT ?? 8787}`;
// The app runs Amble on the device: its API in a worker, on SQLite in the browser. Built with
// relative paths, an Amble server serves it under its own path and writes that into the page. For
// any other host (a static site, the Android app), AMBLE_BASE says the path it's served under.
const fixedBase = process.env.AMBLE_BASE;

function filesIn(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesIn(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/**
 * Builds web/src/sw.ts into sw.js beside the app once everything else is written, with this
 * build's files to keep for offline use and an id that changes whenever any of them does.
 */
function serviceWorker(): Plugin {
  let root = '';
  let outDir = '';
  return {
    name: 'amble-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = filesIn(outDir).filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(outDir, f)));
      // The page is fetched on its own, since a server fills in the base path. Fonts for other
      // scripts download only when a page needs them, so the worker keeps those as they come.
      const assets = files.filter((f) => f !== 'index.html' && (!f.endsWith('.woff2') || /-latin(-ext)?-/.test(f)));
      await build({
        configFile: false,
        logLevel: 'warn',
        root,
        define: {
          __AMBLE_BUILD__: JSON.stringify(hash.digest('hex').slice(0, 12)),
          __AMBLE_ASSETS__: JSON.stringify(assets),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          lib: { entry: path.join(root, 'src/sw.ts'), formats: ['iife'], name: 'ambleServiceWorker', fileName: () => 'sw.js' },
        },
      });
    },
  };
}

/**
 * A server writes a <base> into the page so its relative links work on any page; elsewhere there's
 * no server, so a build for a fixed path has it written in here (otherwise /settings/sync asks for
 * /settings/icon.svg).
 */
function baseTag(base: string): Plugin {
  return { name: 'amble-base-tag', transformIndexHtml: (html) => html.replace('<head>', `<head>
    <base href="${base}" />`) };
}

export default defineConfig({
  root: 'web',
  // .env sits beside package.json; only its VITE_ settings (the Google client for Drive sync) reach the app.
  envDir: import.meta.dirname,
  // Relative asset URLs plus a server-injected <base href> let one build run under any path prefix.
  base: fixedBase ?? './',
  publicDir: 'public',
  plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', jsx: 'react' }), serviceWorker(), ...(fixedBase ? [baseTag(fixedBase)] : [])],
  resolve: {
    // drizzle's driver module names better-sqlite3, which the device's worker never uses.
    alias: process.env.VITEST ? {} : { 'better-sqlite3': path.join(import.meta.dirname, 'web/src/worker/no-native.ts') },
  },
  // SQLite's WebAssembly build finds its .wasm file itself; pre-bundling would break that.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  test: {
    // Vite's root is web/, but server tests live beside the server code.
    dir: import.meta.dirname,
    // Worktrees of other sessions live under .claude/ and carry their own copy of every test.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // `AMBLE_SQLITE=wasm pnpm test` runs the suite on the WebAssembly SQLite the app's worker uses.
    setupFiles: process.env.AMBLE_SQLITE === 'wasm' ? [path.join(import.meta.dirname, 'server/test-wasm.ts')] : [],
    // material-color-utilities has extensionless ESM imports that only a bundler resolves.
    server: { deps: { inline: ['@material/material-color-utilities'] } },
  },
  // On 127.0.0.1:5174, the address Google Drive sign-in is set up for, so http://127.0.0.1:5174
  // and http://localhost:5174 both work: two addresses are two separate sites to the browser,
  // which is handy for trying sync between two "devices". The server's own routes go to `pnpm
  // dev:server`, so the app can sync with it as its own server.
  server: {
    port: 5174,
    host: '127.0.0.1',
    strictPort: true,
    // The server's page is /server, and nothing past it: /server-return is the app's.
    proxy: Object.fromEntries(['/auth', '/sync', '^/server([/?]|$)', '/healthz', '/oauth', '/mcp', '/.well-known', '/google'].map((p) => [p, server])),
  },
});

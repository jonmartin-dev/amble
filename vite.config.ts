import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { build, type Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

const server = `http://localhost:${process.env.PORT ?? 8787}`;
// VITE_ALMANAC_DEVICE=1 builds the app that runs Almanac on the device, with no server: static
// files for any host, under ALMANAC_BASE (default "/").
const device = process.env.VITE_ALMANAC_DEVICE === '1';
const deviceBase = process.env.ALMANAC_BASE ?? '/';

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
    name: 'almanac-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = filesIn(outDir).filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(outDir, f)));
      // The page is fetched from the server, which fills in the base path. Fonts for other
      // scripts download only when a page needs them, so the worker keeps those as they come.
      // A server build never starts the device's database worker, so phones don't fetch it.
      const assets = files.filter(
        (f) => f !== 'index.html' && (!f.endsWith('.woff2') || /-latin(-ext)?-/.test(f)) && (device || !/(api\.worker|sqlite3)/.test(f)),
      );
      await build({
        configFile: false,
        logLevel: 'warn',
        root,
        define: {
          __ALMANAC_BUILD__: JSON.stringify(hash.digest('hex').slice(0, 12)),
          __ALMANAC_ASSETS__: JSON.stringify(assets),
          __ALMANAC_DEVICE__: JSON.stringify(device),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          lib: { entry: path.join(root, 'src/sw.ts'), formats: ['iife'], name: 'almanacServiceWorker', fileName: () => 'sw.js' },
        },
      });
    },
  };
}

/**
 * The server writes a <base> into the page so its relative links work on any page; a device build
 * has no server, so it's written in here (otherwise /settings/sync asks for /settings/icon.svg).
 */
function baseTag(): Plugin {
  return { name: 'almanac-base-tag', transformIndexHtml: (html) => html.replace('<head>', `<head>
    <base href="${deviceBase}" />`) };
}

export default defineConfig({
  root: 'web',
  // .env sits beside package.json; only its VITE_ settings (the Google client for Drive sync) reach the app.
  envDir: import.meta.dirname,
  // Relative asset URLs plus a server-injected <base href> let one build run under any path prefix.
  // A device build has no server to write that in, so it's built for its path.
  base: device ? deviceBase : './',
  publicDir: 'public',
  plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', jsx: 'react' }), serviceWorker(), ...(device ? [baseTag()] : [])],
  resolve: {
    // drizzle's driver module names better-sqlite3, which the device's worker never uses.
    alias: process.env.VITEST ? {} : { 'better-sqlite3': path.join(import.meta.dirname, 'web/src/worker/no-native.ts') },
  },
  // SQLite's WebAssembly build finds its .wasm file itself; pre-bundling would break that.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  build: {
    outDir: device ? '../dist/device' : '../dist/web',
    emptyOutDir: true,
  },
  test: {
    // Vite's root is web/, but server tests live beside the server code.
    dir: import.meta.dirname,
    // Worktrees of other sessions live under .claude/ and carry their own copy of every test.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // `ALMANAC_SQLITE=wasm pnpm test` runs the suite on the WebAssembly SQLite the app's worker uses.
    setupFiles: process.env.ALMANAC_SQLITE === 'wasm' ? [path.join(import.meta.dirname, 'server/test-wasm.ts')] : [],
    // material-color-utilities has extensionless ESM imports that only a bundler resolves.
    server: { deps: { inline: ['@material/material-color-utilities'] } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': server,
      '/auth': server,
      '/healthz': server,
      '/oauth': server,
      '/mcp': server,
      '/.well-known': server,
    },
  },
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { build, type Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

const server = `http://localhost:${process.env.PORT ?? 8787}`;

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
      const assets = files.filter((f) => f !== 'index.html' && (!f.endsWith('.woff2') || /-latin(-ext)?-/.test(f)));
      await build({
        configFile: false,
        logLevel: 'warn',
        root,
        define: {
          __ALMANAC_BUILD__: JSON.stringify(hash.digest('hex').slice(0, 12)),
          __ALMANAC_ASSETS__: JSON.stringify(assets),
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

export default defineConfig({
  root: 'web',
  // Relative asset URLs plus a server-injected <base href> let one build run under any path prefix.
  base: './',
  publicDir: 'public',
  plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', jsx: 'react' }), serviceWorker()],
  build: {
    outDir: '../dist/web',
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

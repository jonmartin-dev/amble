import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vitest/config';

const server = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  // Relative asset URLs plus a server-injected <base href> let one build run under any path prefix.
  base: './',
  publicDir: 'public',
  plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', jsx: 'react' })],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  test: {
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
    },
  },
});

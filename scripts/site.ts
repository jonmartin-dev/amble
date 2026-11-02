// The website (amble-planner.vercel.app): `node scripts/site.ts` writes it to dist/site, a front page
// and the privacy policy as plain HTML that needs no script. The pages are React (site/pages.tsx),
// rendered once here, and the styles are the app's own (site/site.css).
import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { renderToStaticMarkup } from 'react-dom/server';
import Icons from 'unplugin-icons/vite';
import { build, createServer } from 'vite';
import type { pages as Pages, Template } from '../site/pages.tsx';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'dist/site');

// The stylesheet, and the fonts it names, under names that change when they do.
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [tailwindcss()],
  build: { outDir: out, emptyOutDir: true, manifest: true, rollupOptions: { input: path.join(root, 'site/site.css') } },
});
const manifest = JSON.parse(fs.readFileSync(path.join(out, '.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>;
const css = `/${manifest['site/site.css']!.file}`;
fs.rmSync(path.join(out, '.vite'), { recursive: true });

// The list templates, in the order the site shows them.
const order = ['groceries', 'meals', 'packing', 'routine', 'gifts', 'errands', 'shopping', 'hardware', 'watch', 'places', 'default'];
const templates = order.map((id) => {
  const t = JSON.parse(fs.readFileSync(path.join(root, 'templates', `${id}.json`), 'utf8')) as Template;
  return { id: t.id, name: t.name, description: t.description, icon: t.icon, color: t.color };
});
const policy = fs.readFileSync(path.join(root, 'docs/privacy-policy.md'), 'utf8');

// The pages. The app's color library has imports only a bundler resolves, so Vite loads them.
const vite = await createServer({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [react(), Icons({ compiler: 'jsx', jsx: 'react' })],
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  ssr: { noExternal: ['@material/material-color-utilities'] },
});
try {
  const { pages } = (await vite.ssrLoadModule('/site/pages.tsx')) as { pages: typeof Pages };
  for (const page of pages) {
    const file = path.join(out, page.path, 'index.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<!doctype html>${renderToStaticMarkup(page.render({ css, policy, templates }))}`);
  }
} finally {
  await vite.close();
}

// The pictures, as they are.
fs.copyFileSync(path.join(root, 'web/public/icon.svg'), path.join(out, 'icon.svg'));
fs.copyFileSync(path.join(root, 'fastlane/metadata/android/en-US/images/featureGraphic.png'), path.join(out, 'og.png'));
fs.cpSync(path.join(root, 'docs/screenshots'), path.join(out, 'screenshots'), { recursive: true });
console.log(`Wrote ${path.relative(root, out)}`);

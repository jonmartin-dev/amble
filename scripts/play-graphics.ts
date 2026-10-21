// The Play listing's artwork: the 512px icon (the full-bleed sunrise, which Play rounds itself) and
// the 1024x500 feature graphic, the same sunrise stretched wide with the name in the app's own type.
// Usage: node scripts/play-graphics.ts   -> fastlane/metadata/android/en-US/images/
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'fastlane/metadata/android/en-US/images');
const font = pathToFileURL(path.join(root, 'node_modules/@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-full-normal.woff2')).href;
fs.mkdirSync(out, { recursive: true });

// The icon's colors and shapes (web/public/icon.svg), laid out for a banner: the name on the sky at
// the left, clear of the edges Play may crop, and the sun rising behind the hills at the right.
const feature = `<!doctype html>
<style>
  @font-face { font-family: 'Google Sans Flex'; src: url('${font}') format('woff2'); font-weight: 100 1000; }
  html, body { margin: 0; }
  .banner { position: relative; width: 1024px; height: 500px; overflow: hidden; background: #FDE6D2; font-family: 'Google Sans Flex'; }
  svg { position: absolute; inset: 0; }
  h1 { position: absolute; left: 96px; top: 64px; margin: 0; font-size: 112px; font-weight: 560; letter-spacing: -2px; color: #2E6A57; }
  p { position: absolute; left: 100px; top: 202px; margin: 0; font-size: 34px; font-weight: 450; color: #6B4A33; }
</style>
<div class="banner">
  <svg viewBox="0 0 1024 500" width="1024" height="500">
    <circle cx="780" cy="268" r="92" fill="#EE8C52"/>
    <path d="M0 404C250 336 560 258 780 262C900 264 984 292 1024 306V500H0Z" fill="#8DBBA6"/>
    <path d="M0 470C140 418 290 372 430 378C610 386 770 456 1024 432V500H0Z" fill="#2E6A57"/>
  </svg>
  <h1>Amble</h1>
  <p>A calm planner for your household</p>
</div>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1024, height: 500 } });
const html = path.join(out, '..', 'feature.tmp.html');
fs.writeFileSync(html, feature);
await page.goto(pathToFileURL(html).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(out, 'featureGraphic.png'), clip: { x: 0, y: 0, width: 1024, height: 500 } });
fs.rmSync(html);

// The icon: the maskable one is already full-bleed. Drawn on white-free ground, so it has no transparency.
await page.setViewportSize({ width: 512, height: 512 });
await page.goto(pathToFileURL(path.join(root, 'web/public/icon-maskable-512.png')).href);
await page.screenshot({ path: path.join(out, 'icon.png'), clip: { x: 0, y: 0, width: 512, height: 512 }, omitBackground: false });
await browser.close();
console.log(`${path.relative(root, out)}/featureGraphic.png, icon.png`);

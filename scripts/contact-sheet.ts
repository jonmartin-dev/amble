// Lays design/screens/*.png out as one row per variant: design/screens/_sheet.png
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const dir = path.resolve('design/screens');
const order = ['today', 'backlog', 'calendar', 'stats', 'appearance'];
const rows = new Map<string, string[]>();
for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^(.+)-(today|backlog|calendar|stats|appearance)\.png$/);
  if (m) rows.set(m[1]!, [...(rows.get(m[1]!) ?? []), f]);
}

const img = (f: string) => `<img src="${pathToFileURL(path.join(dir, f)).href}" style="width:260px">`;
const html = [...rows]
  .map(([variant, files]) => {
    const cells = order.map((r) => files.find((f) => f.endsWith(`-${r}.png`))).filter((f): f is string => Boolean(f));
    return `<div style="padding:8px 8px 0;color:#fff">${variant}</div><div style="display:flex;gap:8px;padding:8px;align-items:flex-start">${cells.map(img).join('')}</div>`;
  })
  .join('');

const sheet = path.join(dir, '_sheet.html');
fs.writeFileSync(sheet, `<body style="margin:0;background:#777;font:14px sans-serif">${html}</body>`);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1360, height: 800 } });
await page.goto(pathToFileURL(sheet).href);
await page.waitForLoadState('load');
await page.screenshot({ path: path.join(dir, '_sheet.png'), fullPage: true });
await browser.close();
console.log(path.join(dir, '_sheet.png'));

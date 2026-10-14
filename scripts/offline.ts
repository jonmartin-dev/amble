// Checks offline use end to end in a phone-sized Chrome: the app opens with no connection, changes
// made offline show at once and survive a reload, they sync in order when the connection is back,
// and a new deploy is offered as a reload.
// Needs a production build served by the app's own server (the service worker only runs there):
// `pnpm build`, then `node --env-file=.env server/index.ts` with ALMANAC_DATA_DIR set to a
// throwaway database (see scripts/demo.ts) and ALMANAC_PUBLIC_URL matching ALMANAC_URL below.
// It changes that data, and briefly appends a comment to dist/web/sw.js to stand in for a deploy.
// Usage: ALMANAC_URL=http://localhost:8790 node scripts/offline.ts <email>
import fs from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const base = process.env.ALMANAC_URL ?? 'http://localhost:8787';
const email = process.argv[2];
if (!email) throw new Error('Usage: node scripts/offline.ts <email>');
const swFile = new URL('../dist/web/sw.js', import.meta.url);

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
// Failed requests while offline are expected; anything else in the console is not.
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(m.text()) && errors.push(m.text()));

let step = 0;
async function check(name: string, fn: (p: Page) => Promise<void>) {
  step++;
  try {
    await fn(page);
    console.log(`ok ${step} ${name}`);
  } catch (err) {
    console.error(`FAILED ${step} ${name}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    await page.screenshot({ path: `design/screens/_offline-fail-${step}.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  }
}
const run = Date.now().toString(36).slice(-4);
const NEW_TASK = `Offline ${run}: call the plumber`;
const NEW_STEP = `Find the number ${run}`;
const NEW_ITEM = `Offline ${run} lemons`;
const json = async <T>(path: string) => (await (await page.request.get(`${base}/api${path}`)).json()) as T;
type T = { id: string; title: string; status: string; subtasks: { title: string }[] };

await page.goto(`${base}/auth/dev?email=${encodeURIComponent(email)}`);
await page.waitForLoadState('networkidle');
// Skip the morning briefing; this is about Today.
await page.request.post(`${base}/api/briefing/seen`, { data: {} });
await page.goto(`${base}/`);
await page.waitForLoadState('networkidle');

const day = await json<{ planned: T[] }>('/today');
const target = day.planned.find((t) => t.status === 'open');
if (!target) throw new Error('Needs an open task planned for today; run it on a fresh demo database.');
const { groups } = await json<{ groups: { id: string; kind: string; name: string }[] }>('/groups');
const list = groups.find((g) => g.kind === 'list')!;
const before = await json<{ open: { id: string; name: string }[] }>(`/lists/${list.id}`);
const item = before.open[0]!;

await check('the service worker takes over and keeps the app', async (p) => {
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await p.waitForLoadState('networkidle');
  if (!(await p.evaluate(() => navigator.serviceWorker.controller != null))) throw new Error('page is not controlled by the service worker');
  // Let the cache reach IndexedDB (it's written about once a second).
  await p.waitForTimeout(1500);
});

await context.setOffline(true);

await check('the app opens offline with what was last loaded', async (p) => {
  await p.reload();
  await p.getByRole('main').getByText(target.title).first().waitFor({ timeout: 8000 });
  await p.getByText('Offline', { exact: true }).waitFor({ timeout: 5000 });
});

await check('finishing a task offline shows at once', async (p) => {
  await p.getByRole('checkbox', { name: `Complete ${target.title}` }).click();
  await p.getByText(`Done: ${target.title}`).waitFor({ timeout: 5000 });
  await p.getByText(/Offline · 1 change to sync/).waitFor({ timeout: 5000 });
});

await check('adding a task offline puts it on today', async (p) => {
  await p.getByRole('button', { name: 'Add a task' }).click();
  await p.getByText(/Add a task/).first().waitFor();
  await p.getByLabel('Task', { exact: true }).fill(NEW_TASK);
  await p.getByRole('button', { name: 'Add', exact: true }).click();
  await p.getByText(`Added "${NEW_TASK}"`).waitFor({ timeout: 5000 });
  await p.keyboard.press('Escape');
  await p.getByRole('main').getByText(NEW_TASK).filter({ visible: true }).waitFor({ timeout: 5000 });
});

await check('a task made offline opens and takes a new step', async (p) => {
  await p.getByRole('main').getByText(NEW_TASK).filter({ visible: true }).click();
  await p.getByLabel('Add a step').fill(NEW_STEP);
  await p.keyboard.press('Enter');
  await p.getByText(NEW_STEP).waitFor({ timeout: 5000 });
});

await check('a list works offline: check one off, add one', async (p) => {
  await p.goto(`${base}/list/${list.id}`);
  await p.getByRole('checkbox', { name: `Got ${item.name}` }).click();
  await p.getByRole('checkbox', { name: `Got ${item.name}` }).waitFor({ state: 'detached', timeout: 5000 });
  await p.getByLabel('Item', { exact: true }).fill(NEW_ITEM);
  await p.getByRole('button', { name: 'Add item' }).click();
  await p.getByText(NEW_ITEM).waitFor({ timeout: 5000 });
  await p.getByText(/Offline · 5 changes to sync/).waitFor({ timeout: 5000 });
});

await check('offline changes survive a reload with no connection', async (p) => {
  await p.waitForTimeout(1200);
  await p.goto(`${base}/`);
  // Visible: the tabs kept in the background have their own (hidden) copy.
  await p.getByRole('main').getByText(NEW_TASK).filter({ visible: true }).waitFor({ timeout: 8000 });
  await p.getByText(/Offline · 5 changes to sync/).waitFor({ timeout: 5000 });
});

await context.setOffline(false);

await check('back online, everything syncs and the server has it', async (p) => {
  await p.getByText('All synced').waitFor({ timeout: 15000 });
  const t = await json<{ task: T }>(`/tasks/${target.id}`);
  if (t.task.status !== 'done') throw new Error(`"${target.title}" is ${t.task.status} on the server`);
  const found = await json<{ tasks: T[] }>(`/tasks?q=${encodeURIComponent(NEW_TASK)}`);
  if (found.tasks.length !== 1) throw new Error(`expected one "${NEW_TASK}", found ${found.tasks.length}`);
  if (found.tasks[0]!.subtasks.map((s) => s.title).join() !== NEW_STEP) throw new Error('the new step is missing');
  const after = await json<{ open: { name: string }[]; checked: { name: string }[] }>(`/lists/${list.id}`);
  if (!after.checked.some((i) => i.name === item.name)) throw new Error(`${item.name} isn't checked off`);
  if (!after.open.some((i) => i.name === NEW_ITEM)) throw new Error(`${NEW_ITEM} isn't on the list`);
});

const original = fs.readFileSync(swFile, 'utf8');
try {
  await check('a new deploy is offered as a reload', async (p) => {
    fs.writeFileSync(swFile, `${original}\n// stand-in deploy ${run}\n`);
    await p.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    await p.getByText('A new version is ready').waitFor({ timeout: 10000 });
    await Promise.all([p.waitForEvent('load', { timeout: 10000 }), p.getByRole('button', { name: 'Reload' }).click()]);
    await p.getByRole('main').waitFor({ timeout: 8000 });
    if (await p.getByText('A new version is ready').isVisible()) throw new Error('the prompt is still showing after the reload');
  });
} finally {
  fs.writeFileSync(swFile, original);
}

if (errors.length) {
  console.error(`Console errors:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  process.exitCode = 1;
}
await browser.close();

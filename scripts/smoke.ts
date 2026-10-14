// Clicks through the core loop in a phone-sized Chrome and fails on any broken step or console error.
// Needs `pnpm dev` running against a throwaway database (see scripts/demo.ts). It changes that data.
// Usage: node scripts/smoke.ts <email>
import { chromium, type Page } from 'playwright-core';

const base = process.env.ALMANAC_URL ?? 'http://localhost:5173';
const email = process.argv[2];
if (!email) throw new Error('Usage: node scripts/smoke.ts <email>');

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

let step = 0;
async function check(name: string, fn: (p: Page) => Promise<void>) {
  step++;
  try {
    await fn(page);
    console.log(`ok ${step} ${name}`);
  } catch (err) {
    console.error(`FAILED ${step} ${name}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    await page.screenshot({ path: `design/screens/_smoke-fail-${step}.png`, fullPage: true });
    process.exitCode = 1;
  }
}
const until = (p: Page, text: string | RegExp) => p.getByText(text).first().waitFor({ timeout: 5000 });
// Each run makes its own things, so runs against the same database don't collide.
const run = Date.now().toString(36).slice(-4);
const TASK = `Smoke ${run}: buy stamps`;
const ITEM = `Smoke ${run} basil`;
const GROUP = `Garden ${run}`;

await page.goto(`${base}/auth/dev?email=${encodeURIComponent(email)}`);
await page.waitForLoadState('networkidle');

await check('quick add puts a task on today', async (p) => {
  await p.getByRole('button', { name: 'Add a task' }).click();
  await p.getByLabel('Task', { exact: true }).fill(TASK);
  await p.getByRole('button', { name: 'Morning' }).click();
  await p.getByRole('button', { name: 'Add', exact: true }).click();
  await until(p, `Added "${TASK}"`);
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  await p.getByRole('main').getByText(TASK).waitFor({ timeout: 5000 });
});

await check('completing moves it to done, and Undo brings it back', async (p) => {
  await p.getByRole('checkbox', { name: `Complete ${TASK}` }).click();
  await until(p, `Done: ${TASK}`);
  await p.getByRole('button', { name: 'Undo' }).click();
  await p.getByRole('checkbox', { name: `Complete ${TASK}` }).waitFor({ timeout: 5000 });
});

await check('the task page edits steps, links and notes', async (p) => {
  await p.getByRole('main').getByText(TASK).click();
  await p.waitForURL(/\/task\//);
  await p.getByLabel('Add a step').fill('Find the post office hours');
  await p.getByLabel('Add a step').press('Enter');
  await until(p, 'Find the post office hours');
  await p.getByRole('checkbox', { name: 'Find the post office hours' }).click();
  await p.getByLabel('Add a link').fill('usps.com');
  await p.getByLabel('Add a link').press('Enter');
  await until(p, 'usps.com/');
  await p.getByLabel('Notes', { exact: true }).fill('Forever stamps, two books');
  await p.getByLabel('Add a step').click();
  await p.waitForTimeout(500);
  await p.reload();
  await until(p, 'Forever stamps, two books');
  const step = p.getByRole('checkbox', { name: 'Find the post office hours' });
  if ((await step.getAttribute('aria-checked')) !== 'true') throw new Error('step did not stay checked');
});

await check('moving to tomorrow from the task page', async (p) => {
  await p.getByRole('button', { name: 'Today' }).first().click();
  await p.getByRole('dialog', { name: 'Move task' }).getByText('Tomorrow').click();
  await until(p, 'Moved to tomorrow');
  await p.getByRole('button', { name: 'Tomorrow' }).first().waitFor({ timeout: 5000 });
});

await check('handing it to someone else with a note', async (p) => {
  const field = p.getByText('For', { exact: true }).locator('..');
  if (!(await field.count())) return;
  const names = (await field.getByRole('button').allInnerTexts()).map((n) => n.trim());
  const other = names.find((n) => !['Me', 'Anyone'].includes(n));
  if (!other) return;
  await field.getByRole('button', { name: other, exact: true }).click();
  await p.getByLabel('Note', { exact: true }).fill('You pass the post office');
  await p.getByRole('button', { name: 'Hand it over' }).click();
  await until(p, '"You pass the post office"');
});

await check('removing a task, then undoing it', async (p) => {
  await p.getByRole('button', { name: 'Remove task' }).click();
  await until(p, `Removed ${TASK}`);
  // The previous snackbar may still be fading out, so take the newest Undo.
  await p.getByRole('button', { name: 'Undo' }).last().click();
  await p.waitForTimeout(600);
  const res = await p.request.get(`${base}/api/tasks?q=${encodeURIComponent(TASK)}`);
  const { tasks } = (await res.json()) as { tasks: unknown[] };
  if (tasks.length !== 1) throw new Error('task was not restored');
});

await check('backlog search finds it', async (p) => {
  await p.goto(`${base}/backlog`);
  await p.getByLabel('Search tasks').fill(TASK);
  await p.getByRole('main').getByText(TASK).waitFor({ timeout: 5000 });
});

await check('the grocery list adds and checks off items', async (p) => {
  await p.goto(`${base}/backlog`);
  await p.getByRole('link', { name: /Groceries/ }).click();
  await p.getByLabel('Item', { exact: true }).fill(ITEM);
  await p.getByLabel('Quantity', { exact: true }).fill('1');
  await p.getByRole('button', { name: 'Add item' }).click();
  await until(p, ITEM);
  await p.getByRole('checkbox', { name: `Got ${ITEM}` }).click();
  await p.getByRole('checkbox', { name: `Got ${ITEM}` }).waitFor({ state: 'detached', timeout: 5000 });
});

await check('creating a group from the backlog', async (p) => {
  await p.goto(`${base}/backlog`);
  await p.getByRole('button', { name: 'New group or list' }).click();
  await p.getByLabel('Name', { exact: true }).fill(GROUP);
  await p.getByRole('button', { name: 'Create' }).click();
  await until(p, `Made ${GROUP}`);
});

await check('swiping a task right completes it', async (p) => {
  const title = `Smoke ${run}: swipe me`;
  await p.goto(`${base}/`);
  await p.getByRole('button', { name: 'Add a task' }).click();
  await p.getByLabel('Task', { exact: true }).fill(title);
  await p.getByRole('button', { name: 'Add', exact: true }).click();
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  const row = p.getByRole('main').getByText(title);
  await row.waitFor({ timeout: 5000 });
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(300);
  const box = (await row.boundingBox())!;
  await p.mouse.move(box.x + 20, box.y + box.height / 2);
  await p.mouse.down();
  for (let dx = 0; dx <= 180; dx += 20) {
    await p.mouse.move(box.x + 20 + dx, box.y + box.height / 2);
    await p.waitForTimeout(16);
  }
  await p.mouse.up();
  await until(p, `Done: ${title}`);
});

await check("the calendar's day sheet pulls a task in from the backlog", async (p) => {
  const title = `Smoke ${run}: calendar`;
  // Must-do and due today, so it's first among the backlog suggestions.
  const today = await p.evaluate(() => {
    const d = new Date();
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await p.request.post(`${base}/api/tasks`, { data: { title, mustDo: true, dueDate: today } });
  await p.goto(`${base}/calendar`);
  await p.getByRole('radio', { name: 'Week' }).click();
  await p.getByRole('button', { name: /^Today ·/ }).click();
  const sheet = p.getByRole('dialog', { name: 'Day plan' });
  await sheet.getByRole('button', { name: `Plan ${title} for this day` }).click();
  await until(p, 'Moved to today');
  await sheet.getByText(title).first().waitFor({ timeout: 5000 });
  await p.keyboard.press('Escape');
});

await check('the month view shows the whole month', async (p) => {
  await p.getByRole('radio', { name: 'Month' }).click();
  await p.waitForTimeout(400);
  const cells = await p.getByRole('main').getByRole('button', { name: /^\w+day, / }).count();
  if (cells < 28) throw new Error(`only ${cells} days in the month grid`);
  await p.getByRole('radio', { name: 'Week' }).click();
});

await check('stats and activity show what happened', async (p) => {
  await p.goto(`${base}/stats`);
  await until(p, /\d+ things? done/);
  await p.goto(`${base}/activity`);
  await p.getByRole('main').getByText(TASK).first().waitFor({ timeout: 5000 });
});

await check('settings rename a group, archive it and bring it back', async (p) => {
  await p.goto(`${base}/settings/groups`);
  await p.getByRole('button', { name: new RegExp(`^${GROUP}`) }).click();
  await p.getByLabel('Name', { exact: true }).fill(`${GROUP} beds`);
  await p.getByRole('button', { name: 'Save' }).click();
  await until(p, `Saved ${GROUP} beds`);
  await p.getByRole('button', { name: new RegExp(`^${GROUP} beds`) }).click();
  await p.getByRole('button', { name: 'Archive group' }).click();
  await until(p, `Archived ${GROUP} beds`);
  await p.getByRole('button', { name: 'Undo' }).last().click();
  await p.waitForTimeout(600);
  const { groups } = (await (await p.request.get(`${base}/api/groups`)).json()) as { groups: { name: string }[] };
  if (!groups.some((g) => g.name === `${GROUP} beds`)) throw new Error('group was not restored');
});

await check("capacity changes how full today is", async (p) => {
  await p.goto(`${base}/settings/capacity`);
  const day = await p.evaluate(() => {
    const d = new Date();
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  });
  const before = ((await (await p.request.get(`${base}/api/today`)).json()) as { load: { capacityMinutes: number } }).load.capacityMinutes;
  await p.getByRole('button', { name: `More time on ${day}` }).click();
  await p.waitForTimeout(1200);
  const after = ((await (await p.request.get(`${base}/api/today`)).json()) as { load: { capacityMinutes: number } }).load.capacityMinutes;
  if (after !== before + 30) throw new Error(`capacity went from ${before} to ${after}`);
  await p.getByRole('button', { name: `Less time on ${day}` }).click();
  await p.waitForTimeout(1200);
});

await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: all passed');

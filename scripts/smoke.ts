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
let step = 0;
page.on('pageerror', (e) => errors.push(`step ${step}: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`step ${step}: ${m.text()}`));

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

await check("the day's first open shows the briefing, and Start my day goes to Today", async (p) => {
  const briefing = (await (await p.request.get(`${base}/api/briefing`)).json()) as { seen: boolean };
  // A database someone already opened today skips it; nothing to check then.
  if (briefing.seen && !p.url().endsWith('/briefing')) return console.log('   (skipped: already seen today)');
  await p.getByRole('button', { name: 'Start my day' }).waitFor({ timeout: 8000 });
  await p.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }).waitFor();
  await p.getByRole('button', { name: 'Start my day' }).click();
  await p.getByRole('heading', { name: /^Here's today/ }).waitFor({ timeout: 5000 });
  await p.reload();
  await p.waitForLoadState('networkidle');
  if (p.url().endsWith('/briefing')) throw new Error('the briefing came up a second time');
});

// Plain quick add first; smart add (which calls Haiku) gets its own step below.
await page.request.patch(`${base}/api/me`, { data: { smartAdd: false } });
await page.reload();

await check('quick add puts a task on today', async (p) => {
  await p.getByRole('button', { name: 'Add a task' }).click();
  await p.getByLabel('Task', { exact: true }).fill(TASK);
  await p.getByRole('button', { name: 'Any time' }).click();
  await p.getByRole('button', { name: 'Morning' }).click();
  await p.getByRole('button', { name: 'Add', exact: true }).click();
  await until(p, `Added "${TASK}"`);
  await p.keyboard.press('Escape');
  await p.getByRole('main').getByText(TASK).waitFor({ timeout: 5000 });
});

await check('the add sheet rides on the keyboard, and Back closes it', async (p) => {
  const url = p.url();
  await p.getByRole('button', { name: 'Add a task' }).click();
  const sheet = p.getByRole('dialog', { name: 'Add' });
  await sheet.waitFor();
  // Phones shrink the visual viewport when the keyboard opens; fake a 300px keyboard.
  await p.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { get: () => window.innerHeight - 300, configurable: true });
    vv.dispatchEvent(new Event('resize'));
  });
  const viewport = p.viewportSize()!;
  // The sheet springs up onto the keyboard; give it a moment to settle there.
  let bottom = 0;
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(100);
    const box = (await sheet.boundingBox())!;
    bottom = box.y + box.height;
    if (Math.abs(bottom - (viewport.height - 300)) <= 2) break;
  }
  if (Math.abs(bottom - (viewport.height - 300)) > 2) throw new Error(`sheet bottom at ${bottom}, keyboard top at ${viewport.height - 300}`);
  const input = (await p.getByLabel('Task', { exact: true }).boundingBox())!;
  if (input.y + input.height > viewport.height - 300) throw new Error('the text box is under the keyboard');
  await p.goBack();
  await sheet.waitFor({ state: 'detached', timeout: 5000 });
  if (p.url() !== url) throw new Error(`Back left the page for ${p.url()}`);
  await p.reload();
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
  await until(p, `Added "${title}"`);
  await p.keyboard.press('Escape');
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

await check('pinning capacity changes how full today is, and unpinning goes back to learning', async (p) => {
  await p.goto(`${base}/settings/capacity`);
  const day = await p.evaluate(() => {
    const d = new Date();
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  });
  // Before the calendar's adjustment, which scales the pinned number along with everything else.
  const capacity = async () => ((await (await p.request.get(`${base}/api/today`)).json()) as { load: { baseCapacityMinutes: number } }).load.baseCapacityMinutes;
  const before = await capacity();
  await p.getByRole('button', { name: `More time on ${day}` }).click();
  await p.waitForTimeout(1200);
  const after = await capacity();
  if (after !== before + 30) throw new Error(`capacity went from ${before} to ${after}`);
  await p.getByRole('button', { name: `Let Almanac learn ${day}` }).click();
  await p.waitForTimeout(1200);
  if ((await capacity()) !== before) throw new Error('unpinning did not go back to the learned number');
});

await check('a repeating task comes back after it is finished', async (p) => {
  const title = `Smoke ${run}: bins out`;
  const created = await p.request.post(`${base}/api/tasks`, { data: { title, repeat: { mode: 'schedule', every: 1, unit: 'day' } } });
  const { task } = (await created.json()) as { task: { id: string } };
  await p.goto(`${base}/task/${task.id}`);
  await until(p, 'Every day');
  await p.getByRole('checkbox', { name: 'Complete' }).click();
  await p.waitForTimeout(800);
  const { tasks } = (await (await p.request.get(`${base}/api/tasks?q=${encodeURIComponent(title)}`)).json()) as { tasks: { id: string }[] };
  if (tasks.length !== 1 || tasks[0]!.id === task.id) throw new Error('no next one was made');
  await p.goto(`${base}/task/${tasks[0]!.id}`);
  await p.getByRole('button', { name: 'Skip next' }).click();
  await until(p, /Skipped. Next one/);
  await p.getByRole('button', { name: 'Every day' }).click();
  await p.getByRole('button', { name: 'Stop repeating' }).click();
  await until(p, "Doesn't repeat");
});

await check('a packing list starts from its template and resets for the next trip', async (p) => {
  const name = `Trip ${run}`;
  await p.goto(`${base}/backlog`);
  await p.getByRole('button', { name: 'New group or list' }).click();
  await p.getByRole('button', { name: 'Shopping-style list' }).click();
  await p.getByRole('radio', { name: /^Packing/ }).click();
  await p.getByLabel('Name', { exact: true }).fill(name);
  await p.getByRole('button', { name: 'Create' }).click();
  await until(p, `Made ${name}`);
  await p.getByRole('link', { name: new RegExp(name) }).click();
  await p.getByRole('heading', { name: 'Toiletries' }).waitFor({ timeout: 5000 });
  await p.getByRole('checkbox', { name: 'Got Toothbrush' }).click();
  await p.getByRole('checkbox', { name: 'Got Toothbrush' }).waitFor({ state: 'detached', timeout: 5000 });
  await p.getByRole('button', { name: 'Reset' }).click();
  await p.getByRole('checkbox', { name: 'Got Toothbrush' }).waitFor({ timeout: 5000 });
});

await check('smart add reads what was typed and saves it after review', async (p) => {
  const ai = (await (await p.request.get(`${base}/api/ai`)).json()) as { available: boolean };
  if (!ai.available) return console.log('   (skipped: no Anthropic key on this server)');
  await p.request.patch(`${base}/api/me`, { data: { smartAdd: true } });
  await p.goto(`${base}/`);
  await p.getByRole('button', { name: 'Add a task' }).click();
  await p.getByLabel('What to add').fill('water the ferns every sunday');
  await p.keyboard.press('Enter');
  // Haiku usually answers in a few seconds, sometimes more.
  await p.getByText("Here's what I got").first().waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: /^Add (all )?\d+$/ }).click();
  await p.getByRole('dialog', { name: 'Add' }).waitFor({ state: 'detached', timeout: 8000 });
  const { tasks } = (await (await p.request.get(`${base}/api/tasks?q=ferns`)).json()) as { tasks: { id: string; repeat: { weekdays?: number[] } | null }[] };
  const ferns = tasks.find((t) => t.repeat?.weekdays?.includes(7));
  if (!ferns) throw new Error('no repeating ferns task');
  await p.request.post(`${base}/api/tasks/${ferns.id}/archive`, { data: {} });
});

await check('a task due later offers the day with the most room, and plans it there', async (p) => {
  const due = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
  const { task } = (await (await p.request.post(`${base}/api/tasks`, { data: { title: `Smoke ${run}: insurance form`, dueDate: due, estimateMinutes: 30 } })).json()) as { task: { id: string } };
  await p.goto(`${base}/task/${task.id}`);
  await until(p, /has the most room before it's due|is the lightest/);
  await p.getByRole('button', { name: 'Plan it' }).click();
  await until(p, /^Moved to /);
  // The move goes out through the outbox; give it a moment to reach the server.
  let planned: string | null = null;
  for (let i = 0; i < 20 && !planned; i++) {
    await p.waitForTimeout(250);
    planned = ((await (await p.request.get(`${base}/api/tasks/${task.id}`)).json()) as { task: { plannedDate: string | null } }).task.plannedDate;
  }
  if (!planned || planned > due) throw new Error(`planned for ${planned}, due ${due}`);
});

await check('plan my week proposes days and plans what was kept', async (p) => {
  await p.request.post(`${base}/api/tasks`, { data: { title: `Smoke ${run}: sort the garage shelves`, estimateMinutes: 20 } });
  await p.goto(`${base}/calendar`);
  await p.getByRole('button', { name: 'Plan my week' }).click();
  const make = p.getByRole('button', { name: 'Make a plan' });
  if (await make.isVisible({ timeout: 2000 }).catch(() => false)) await make.click();
  const plan = p.getByRole('button', { name: /^Plan \d+ tasks?$/ });
  await plan.waitFor({ timeout: 40000 });
  await plan.click();
  await until(p, /^Planned /);
});

await check('the calendars page explains itself and offers to connect', async (p) => {
  await p.goto(`${base}/settings/calendars`);
  await until(p, 'Plan around your calendar');
  const calendars = (await (await p.request.get(`${base}/api/calendars`)).json()) as { enabled: boolean };
  if (calendars.enabled) await p.getByRole('button', { name: /Connect (Google Calendar|another Google account)/ }).waitFor();
  else await until(p, "Calendar sync isn't set up on this server");
});

await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: all passed');

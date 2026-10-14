// Captures the phone-sized screenshots shown in the README, from the demo household.
// Needs `pnpm dev` running on a demo database (see scripts/demo.ts) and Chrome installed.
// Usage: node scripts/readme-shots.ts [email]   -> docs/screenshots/*.png
import fs from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const base = process.env.ALMANAC_URL ?? 'http://localhost:5173';
const email = process.argv[2] ?? 'sam@example.com';
const out = 'docs/screenshots';
const light = { mode: 'light', seed: '#2e6a57', style: 'tonal', contrast: 0 };
const dark = { mode: 'dark', seed: '#3a5ba9', style: 'vibrant', contrast: 0 };

interface Shot {
  name: string;
  theme: typeof light;
  open: (page: Page) => Promise<void>;
}

const go = (route: string) => async (page: Page) => {
  await page.goto(`${base}${route}`);
  await page.waitForLoadState('networkidle');
};

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const errors: string[] = [];

const signIn = async (page: Page) => {
  await page.goto(`${base}/auth/dev?email=${encodeURIComponent(email)}`);
  const session = (await (await page.request.get(`${base}/api/session`)).json()) as { member: { theme: unknown } | null };
  if (!session.member) throw new Error(`Dev sign-in failed for ${email}. Is the demo database running?`);
  return session.member.theme;
};

// Find the demo's richest task and its grocery list.
const probe = await browser.newPage();
const originalTheme = await signIn(probe);
const { tasks } = (await (await probe.request.get(`${base}/api/tasks`)).json()) as { tasks: { id: string; subtasks: unknown[]; links: unknown[] }[] };
const { groups } = (await (await probe.request.get(`${base}/api/groups`)).json()) as { groups: { id: string; template: string | null }[] };
await probe.close();
const rich = [...tasks].sort((a, b) => b.subtasks.length + b.links.length - (a.subtasks.length + a.links.length))[0];
const groceries = groups.find((g) => g.template === 'groceries');

const shots: Shot[] = [
  { name: 'briefing', theme: light, open: go('/briefing') },
  {
    name: 'today',
    theme: light,
    // Scrolled to the day's list, below the load card and calendar.
    open: async (page) => {
      await go('/')(page);
      await page.getByRole('heading', { name: 'From earlier' }).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 24));
    },
  },
  { name: 'calendar', theme: light, open: go('/calendar') },
  ...(rich ? [{ name: 'task', theme: light, open: go(`/task/${rich.id}`) }] : []),
  ...(groceries ? [{ name: 'groceries', theme: dark, open: go(`/list/${groceries.id}`) }] : []),
  {
    name: 'lists',
    theme: light,
    // The list templates, from the backlog's New group or list.
    open: async (page) => {
      await go('/backlog')(page);
      await page.getByRole('button', { name: 'New group or list' }).locator('visible=true').first().click();
      await page.getByRole('radio', { name: 'List', exact: true }).click();
      await page.getByRole('radio', { name: 'Meal plan' }).click();
    },
  },
  {
    name: 'quick-add',
    theme: light,
    open: async (page) => {
      await go('/')(page);
      await page.getByRole('button', { name: 'Add a task' }).locator('visible=true').first().click();
      await page.keyboard.type('Pick up the dry cleaning');
      await page.getByRole('button', { name: 'Group', exact: true }).click();
    },
  },
  { name: 'appearance', theme: dark, open: go('/appearance') },
];

for (const shot of shots) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: shot.theme.mode === 'dark' ? 'dark' : 'light',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${shot.name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}: ${m.text()}`));
  await signIn(page);
  // Saved as the member's theme too, so the server copy doesn't override it.
  await page.request.patch(`${base}/api/me`, { data: { theme: shot.theme } });
  await page.evaluate((t) => localStorage.setItem('almanac-theme', JSON.stringify(t)), shot.theme);
  await shot.open(page);
  await page.waitForTimeout(900);
  const file = `${out}/${shot.name}.png`;
  await page.screenshot({ path: file });
  console.log(file);
  await context.close();
}

const restore = await browser.newPage();
await signIn(restore);
await restore.request.patch(`${base}/api/me`, { data: { theme: originalTheme } });
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}

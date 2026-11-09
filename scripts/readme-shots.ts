// Captures the phone-sized screenshots shown in the README, from the demo household.
// Needs an Amble server with AMBLE_DEV_LOGIN=1 serving the built app on a demo database (see
// scripts/demo.ts), and Chrome installed.
// Usage: node scripts/readme-shots.ts [email]   -> docs/screenshots/*.png
// With AMBLE_SHOTS=play, the Play listing's phone screenshots instead: 1080x1920 (Play takes 9:16
// only), numbered in the listing's order, in fastlane/metadata/android/en-US/images/phoneScreenshots.
import fs from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { joinHousehold, local, syncNow } from './lib/household.ts';

const base = process.env.AMBLE_URL ?? 'http://localhost:8787';
const email = process.argv[2] ?? 'sam@example.com';
const play = process.env.AMBLE_SHOTS === 'play';
const out = play ? 'fastlane/metadata/android/en-US/images/phoneScreenshots' : 'docs/screenshots';
// The listing leads with the day; the README with the morning's briefing.
const PLAY_ORDER = ['today', 'quick-add', 'calendar', 'groceries', 'task', 'lists', 'briefing', 'appearance'];
const light = { mode: 'light', palette: 'grove', seed: '#2e6a57', style: 'tonal', contrast: 0 };
const dark = { mode: 'dark', palette: 'harbor', seed: '#3a5ba9', style: 'tonal', contrast: 0 };

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
  await joinHousehold(page, base, email);
  const session = (await (await local(page).get(`/session`)).json()) as { member: { theme: unknown } | null };
  if (!session.member) throw new Error(`Dev sign-in failed for ${email}. Is the demo database running?`);
  return session.member.theme;
};

// Find the demo's richest task and its grocery list.
const probe = await browser.newPage();
const originalTheme = await signIn(probe);
const { tasks } = (await (await local(probe).get(`/tasks`)).json()) as { tasks: { id: string; subtasks: unknown[]; links: unknown[] }[] };
const { groups } = (await (await local(probe).get(`/groups`)).json()) as { groups: { id: string; template: string | null }[] };
await probe.close();
const rich = [...tasks].sort((a, b) => b.subtasks.length + b.links.length - (a.subtasks.length + a.links.length))[0];
const groceries = groups.find((g) => g.template === 'groceries');

const shots: Shot[] = [
  { name: 'briefing', theme: light, open: go('/briefing') },
  {
    name: 'today',
    theme: light,
    // Scrolled to the day's list, below the load card and calendar; the listing's first shot shows the top.
    open: async (page) => {
      await go('/')(page);
      if (play) return;
      await page.getByRole('heading', { name: 'From earlier' }).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 24));
      // Scrolling down shrinks the toolbar out of the way (FloatingToolbar). The shot shows it full size.
      await page.waitForTimeout(100);
      await page.locator('.toolbar-body').evaluate((el) => el.removeAttribute('data-compact'));
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

if (play) shots.sort((a, b) => PLAY_ORDER.indexOf(a.name) - PLAY_ORDER.indexOf(b.name));
for (const [i, shot] of shots.entries()) {
  const context = await browser.newContext({
    viewport: play ? { width: 405, height: 720 } : { width: 390, height: 844 },
    deviceScaleFactor: play ? 1080 / 405 : 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: shot.theme.mode === 'dark' ? 'dark' : 'light',
    // The app's own motion turns off, so no page is caught halfway through rising in.
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${shot.name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}: ${m.text()}`));
  await signIn(page);
  // Saved as the member's theme too, so the household's copy doesn't override it.
  await local(page).patch(`/me`, { data: { theme: shot.theme } });
  await page.evaluate((t) => localStorage.setItem('almanac-theme', JSON.stringify(t)), shot.theme);
  // Today's first open shows Here's today over everything else, so only its own shot leaves it unseen.
  if (shot.name !== 'briefing') await local(page).post(`/briefing/seen`, { data: {} });
  await shot.open(page);
  await page.waitForTimeout(900);
  const file = play ? `${out}/${i + 1}_${shot.name}.png` : `${out}/${shot.name}.png`;
  await page.screenshot({ path: file, animations: 'disabled' });
  console.log(file);
  await context.close();
}

const restore = await browser.newPage();
await signIn(restore);
await local(restore).patch(`/me`, { data: { theme: originalTheme } });
await syncNow(restore);
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}

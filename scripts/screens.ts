// Captures every screen at phone size for visual review.
// Needs `pnpm dev` running with AMBLE_DEV_LOGIN=1, and Chrome installed.
// Usage: node scripts/screens.ts [email] [variant,variant]   -> design/screens/*.png
// AMBLE_VIEWPORT=820x1180 captures at another size (a tablet, a Fold opened), into files named for it.
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.AMBLE_URL ?? 'http://localhost:5173';
const email = process.argv[2] ?? 'dev@amble.local';
const out = 'design/screens';
const routes = [
  '/',
  '/backlog',
  '/calendar',
  '/stats',
  '/activity',
  '/settings',
  '/settings/groups',
  '/settings/capacity',
  '/settings/calendars',
  '/settings/notifications',
  '/settings/ai',
  '/appearance',
  '/connections',
  '/household',
  '/privacy',
];
const only = process.argv[3]?.split(',');
const allVariants = [
  { name: 'light', mode: 'light', seed: '#2e6a57', style: 'tonal' },
  { name: 'dark', mode: 'dark', seed: '#2e6a57', style: 'tonal' },
  { name: 'rose-expressive', mode: 'light', seed: '#a8476b', style: 'expressive' },
  { name: 'ocean-dark-vibrant', mode: 'dark', seed: '#3a5ba9', style: 'vibrant' },
];
const variants = only ? allVariants.filter((v) => only.includes(v.name)) : allVariants;
const [width, height] = (process.env.AMBLE_VIEWPORT ?? '390x844').split('x').map(Number);
const file = (variant: string, name: string) => `${out}/${process.env.AMBLE_VIEWPORT ? `${width}x${height}-` : ''}${variant}-${name}.png`;

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const errors: string[] = [];
let originalTheme: unknown = undefined;

for (const v of variants) {
  const context = await browser.newContext({
    viewport: { width: width!, height: height! },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: v.mode === 'dark' ? 'dark' : 'light',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${v.name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${v.name}: ${m.text()}`));

  await page.goto(`${base}/auth/dev?email=${encodeURIComponent(email)}`);
  const session = (await (await page.request.get(`${base}/api/session`)).json()) as { member: { theme: unknown } | null };
  if (!session.member) throw new Error(`Dev sign-in failed for ${email}. Is it on the allowlist?`);
  if (originalTheme === undefined) originalTheme = session.member.theme;
  // Save the variant as this member's theme so the server copy doesn't override it.
  const theme = { mode: v.mode, seed: v.seed, style: v.style, contrast: 0 };
  const res = await page.request.patch(`${base}/api/me`, { data: { theme } });
  if (!res.ok()) throw new Error(`Saving theme failed: ${res.status()}`);
  await page.evaluate((t) => localStorage.setItem('almanac-theme', JSON.stringify(t)), theme);

  // A task with the most detail and the first list, when the data has them.
  const { tasks } = (await (await page.request.get(`${base}/api/tasks`)).json()) as { tasks: { id: string; subtasks: unknown[]; links: unknown[] }[] };
  const { groups } = (await (await page.request.get(`${base}/api/groups`)).json()) as { groups: { id: string; kind: string; template: string | null }[] };
  const rich = [...tasks].sort((a, b) => b.subtasks.length + b.links.length - (a.subtasks.length + a.links.length))[0];
  const list = groups.find((g) => g.kind === 'list');
  const named: [string, string][] = routes.map((r) => [r === '/' ? 'today' : r.slice(1).replace('/', '-'), r]);
  if (rich) named.push(['task', `/task/${rich.id}`]);
  if (list) named.push(['list', `/list/${list.id}`]);
  const packing = groups.find((g) => g.template === 'packing');
  if (packing) named.push(['list-packing', `/list/${packing.id}`]);

  // Closing a sheet takes its history entry back; let that land before navigating.
  const closeSheet = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  };
  const shoot = async (name: string, fullPage = true) => {
    await page.screenshot({ path: file(v.name, name), fullPage });
    console.log(file(v.name, name));
  };
  for (const [name, route] of named) {
    await page.goto(`${base}${route}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    await shoot(name);
  }

  // The sheets: quick add from Today, and moving a task from its detail page.
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add a task' }).click();
  await page.waitForTimeout(800);
  await shoot('add');
  // With the keyboard up (faked: phones shrink the visual viewport), then smart add's review.
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { get: () => window.innerHeight - 320, configurable: true });
    vv.dispatchEvent(new Event('resize'));
  });
  const smart = await page.getByLabel('What to add').count();
  await page.getByLabel(smart ? 'What to add' : 'Task', { exact: true }).fill('pick up a birthday gift for Sam on saturday, and 2 lbs chicken thighs');
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.waitForTimeout(500);
  await shoot('add-keyboard', false);
  if (smart) {
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { get: () => window.innerHeight, configurable: true });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await page.getByText("Here's what I got").waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    await shoot('add-review', false);
    await page.locator('li button[aria-expanded]').last().click();
    await page.waitForTimeout(600);
    await shoot('add-edit', false);
  }
  await closeSheet();
  await page.reload();
  if (rich) {
    await page.goto(`${base}/task/${rich.id}`);
    await page.waitForLoadState('networkidle');
    await page.locator('main').getByText(/Someday|Today|Tomorrow|day$/).locator('visible=true').first().click();
    await page.waitForTimeout(900);
    await shoot('move', false);
    await closeSheet();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Doesn't repeat|Every|Weekly|Monthly|after it's done/ }).locator('visible=true').first().click();
    await page.waitForTimeout(900);
    await shoot('repeat', false);
    await closeSheet();
  }
  // Making a list from a template.
  await page.goto(`${base}/backlog`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'New group or list' }).click();
  await page.getByRole('radio', { name: 'List', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Kind of list' }).getByRole('radio').nth(1).click();
  await page.waitForTimeout(800);
  await shoot('new-list', false);
  await closeSheet();

  // The calendar's month view and a day's plan.
  await page.goto(`${base}/calendar`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.waitForTimeout(700);
  await shoot('calendar-month');
  await page.getByRole('button', { name: /, (Light|Steady|Full|Too much|Wide open)/ }).filter({ hasText: /\d/ }).nth(15).click();
  await page.waitForTimeout(900);
  await shoot('day', false);
  await closeSheet();
  await page.getByRole('radio', { name: 'Week' }).click();

  // Connecting an assistant, with ChatGPT's steps showing.
  await page.goto(`${base}/connections`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('radio', { name: 'ChatGPT' }).click();
  await page.waitForTimeout(600);
  await shoot('connections-chatgpt');

  // The connector consent page, as Claude's and ChatGPT's sign-in would open it (never approved
  // here). The server fetches each one's real client metadata document to show it.
  const assistants = [
    ['consent', 'https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/api/mcp/auth_callback'],
    ['consent-chatgpt', 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect'],
  ];
  for (const [name, clientId, redirectUri] of assistants) {
    const consent = new URLSearchParams({
      response_type: 'code',
      client_id: clientId!,
      redirect_uri: redirectUri!,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    });
    await page.goto(`${base}/oauth/authorize?${consent}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(900);
    await shoot(name!);
  }

  if (v === variants.at(-1)) {
    await page.request.patch(`${base}/api/me`, { data: { theme: originalTheme } });
  }
  await context.close();
}

await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}

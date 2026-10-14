// Captures every screen at phone size for visual review.
// Needs `pnpm dev` running with ALMANAC_DEV_LOGIN=1, and Chrome installed.
// Usage: node scripts/screens.ts [email]   -> design/screens/*.png
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.ALMANAC_URL ?? 'http://localhost:5173';
const email = process.argv[2] ?? 'dev@almanac.local';
const out = 'design/screens';
const routes = ['/', '/backlog', '/calendar', '/stats', '/appearance', '/connections'];
const variants = [
  { name: 'light', mode: 'light', seed: '#2e6a57', style: 'tonal' },
  { name: 'dark', mode: 'dark', seed: '#2e6a57', style: 'tonal' },
  { name: 'rose-expressive', mode: 'light', seed: '#a8476b', style: 'expressive' },
  { name: 'ocean-dark-vibrant', mode: 'dark', seed: '#3a5ba9', style: 'vibrant' },
];

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const errors: string[] = [];
let originalTheme: unknown = undefined;

for (const v of variants) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
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

  for (const route of routes) {
    await page.goto(`${base}${route}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    const file = `${out}/${v.name}${route === '/' ? '-today' : route.replaceAll('/', '-')}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
  // The connector consent page, as Claude's sign-in would open it (never approved here).
  const consent = new URLSearchParams({
    response_type: 'code',
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });
  await page.goto(`${base}/oauth/authorize?${consent}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${v.name}-consent.png`, fullPage: true });
  console.log(`${out}/${v.name}-consent.png`);

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

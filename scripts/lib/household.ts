// For scripts that drive Amble in a browser. Amble runs on the device, so a fresh browser first
// joins the household: it syncs with an Amble server that has dev sign-in on (AMBLE_DEV_LOGIN=1),
// as one of its members. Then `local(page)` asks the app on that device what a script needs.
import type { Page } from 'playwright-core';

/** Opens Amble at `base` and brings the household down from that server, signed in as `email`. */
export async function joinHousehold(page: Page, base: string, email: string) {
  await page.goto(base);
  await page.getByRole('button', { name: 'Get started' }).click();
  // "Join through <server>" when the server serves the page, "Use my own server" anywhere else.
  await page.getByRole('button', { name: /^Join through |^Use my own server$/ }).click();
  // Served by the server, the address is filled in; under `pnpm dev` it's Vite's, which passes the server's routes on.
  const address = page.getByLabel("Your server's address");
  if (!(await address.inputValue())) await address.fill(base);
  await page.getByRole('button', { name: 'Continue' }).click();
  // A server that takes codes asks for one first; dev sign-in is its other way in.
  await page.getByRole('button', { name: /^Sign in with .+ instead$/ }).click();
  const dev = page.getByRole('link', { name: `Dev sign-in as ${email}` });
  if (!(await dev.waitFor({ timeout: 10_000 }).then(() => true, () => false))) throw new Error(`No dev sign-in for ${email} at ${base}. Is AMBLE_DEV_LOGIN=1, and is it on the allowlist?`);
  await dev.click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Back in the app, which brings the household down and then sets this device up as them.
  const app = new URL(base);
  await page.waitForURL((u) => u.origin === app.origin && !u.pathname.slice(app.pathname.replace(/\/$/, '').length).startsWith('/auth'), { timeout: 30_000 });
  await page.waitForFunction(() => window.__ambleFetch !== undefined);
  for (let i = 0; i < 120; i++) {
    const { member } = await (await local(page).get('/session')).json();
    if (member) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`Signed in as ${email}, but this device never joined the household.`);
}

type Reply = { ok(): boolean; status(): number; json(): Promise<any> };

/** The device's own API, shaped like Playwright's page.request: paths as under /api. */
export function local(page: Page) {
  const call =
    (method: string) =>
    async (path: string, options: { data?: unknown } = {}): Promise<Reply> => {
      const { status, body } = await page.evaluate(
        async ({ method, path, data }) => {
          const init: RequestInit = { method };
          if (data !== undefined) Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          const res = await window.__ambleFetch!(path, init);
          return { status: res.status, body: await res.text() };
        },
        { method, path, data: options.data },
      );
      return { ok: () => status < 300, status: () => status, json: async () => JSON.parse(body) };
    };
  return { get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), delete: call('DELETE') };
}

/** Sends this device's changes to the server now, before the browser closes. */
export async function syncNow(page: Page) {
  const res = await local(page).post('/sync/run', { data: {} });
  if (!res.ok()) throw new Error(`Sync failed: ${(await res.json()).error ?? res.status()}`);
}

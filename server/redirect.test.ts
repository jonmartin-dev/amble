// An app moved to another path (AMBLE_REDIRECT_FROM) sends the old address on, and retires the
// service worker that an app installed from the old address still runs.
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { config, type Config } from './config.ts';
import { openDatabase } from './db/index.ts';

const ORIGIN = 'https://amble.test';
const moved: Config = {
  ...config,
  production: false,
  publicUrl: `${ORIGIN}/amble`,
  basePath: '/amble',
  redirectFrom: '/almanac',
  publicOrigin: ORIGIN,
  oidc: { ...config.oidc, clientId: '', clientSecret: '' },
};
const app = createApp({ db: openDatabase(':memory:'), config: moved, oidc: createOidc(moved) });

describe('an app that moved to another path', () => {
  it('sends the old address on to the new one, keeping the method for changes', async () => {
    const page = await app.request(`${ORIGIN}/almanac/task/abc?from=widget`);
    expect(page.status).toBe(301);
    expect(page.headers.get('location')).toBe(`${ORIGIN}/amble/task/abc?from=widget`);
    const change = await app.request(`${ORIGIN}/almanac/api/tasks`, { method: 'POST' });
    expect(change.status).toBe(308);
    expect(change.headers.get('location')).toBe(`${ORIGIN}/amble/api/tasks`);
  });

  it('retires the service worker an app installed from the old address runs', async () => {
    const res = await app.request(`${ORIGIN}/almanac/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const script = await res.text();
    expect(script).toContain('unregister()');
    expect(script).toContain(`"${ORIGIN}/amble/"`);
  });

  it('leaves the new address alone', async () => {
    expect((await app.request(`${ORIGIN}/amble/healthz`)).status).toBe(200);
  });
});

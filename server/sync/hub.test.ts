import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ask, createAi, type Ai } from '../ai/client.ts';
import { fakeAi } from '../ai/testing.ts';
import { createApp } from '../app.ts';
import { createOidc } from '../auth/oidc.ts';
import { createSession } from '../auth/sessions.ts';
import { config, type Config } from '../config.ts';
import { openDatabase, SCHEMA } from '../db/index.ts';
import { aiUsage, members } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import type { FileStore } from '../domain/files.ts';
import { createTasks, listTasks } from '../domain/tasks.ts';
import { createLocalApp, deviceAdopt, deviceConfig } from '../local.ts';
import { createLocalPush } from '../notify/local-push.ts';
import { APP_RETURN } from './hub.ts';
import { createServerSync } from './server.ts';
import { createSyncService } from './service.ts';
import { createGoogle } from '../lib/google.ts';

const HOME = 'https://home.example';
const serverConfig: Config = { ...config, publicUrl: HOME, basePath: '', publicOrigin: HOME, appOrigins: [HOME], devLogin: false, ai: { ...config.ai, apiKey: '' } };

const noFiles: FileStore = {
  save: async () => ({ sha256: '0'.repeat(64), size: 1 }),
  get: async () => null,
  sweep: async () => 0,
};

/** The household's server, with Sam and Ali in it. */
function server(ai?: Ai) {
  const db = openDatabase(':memory:');
  seedStarterGroups(db);
  const sam = db.insert(members).values({ email: 'sam@example.com', name: 'Sam Lee', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  const ali = db.insert(members).values({ email: 'ali@example.com', name: 'Ali Kim', timezone: 'America/Chicago' }).returning().get();
  const sync = createServerSync({ db, config: serverConfig, google: createGoogle(serverConfig), schema: SCHEMA });
  const app = createApp({ db, config: serverConfig, oidc: createOidc(serverConfig), sync, ...(ai && { ai }) });
  // The network as the phone sees it: only the server answers.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${HOME}/`)) throw new TypeError('fetch failed');
    return app.request(input instanceof Request ? input : url, init);
  }) as typeof fetch;
  return { db, sam, ali, sync, app, fetchImpl, cookie: (memberId: string) => `almanac_session=${createSession(db, memberId, 'browser')}` };
}
type Server = ReturnType<typeof server>;

/** A phone with Amble on it, which can reach the server. */
function phone(home: Server) {
  const db = openDatabase(':memory:');
  const cfg = deviceConfig('https://localhost', '', 'America/Chicago');
  const sync = createSyncService({ db, schema: SCHEMA, fetchImpl: home.fetchImpl, adopt: deviceAdopt(db, cfg) });
  // No model of its own: it uses the server's, once it syncs with one.
  const ai = createAi(cfg, db, home.fetchImpl, { seal: (k) => k, open: (k) => k }, () => sync.remoteAi());
  const app = createLocalApp({ db, config: cfg, ai, push: createLocalPush(db, async () => true), files: noFiles, sync, fetchImpl: home.fetchImpl });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`https://localhost/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return { db, sync, ai, call, titles: async () => ((await call('GET', '/tasks')).json.tasks as { title: string }[]).map((t) => t.title).sort() };
}

/** What happens in the browser between the phone and the server: signing in there, then Continue. */
async function signIn(home: Server, memberId: string, verifier = 'v'.repeat(43), redirectUri = APP_RETURN) {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ redirect_uri: redirectUri, state: 'st', code_challenge: challenge, code_challenge_method: 'S256' });
  const cookie = home.cookie(memberId);
  const consent = await home.app.request(`${HOME}/auth/app?${query}`, { headers: { cookie } });
  expect(await consent.text()).toContain('Use Amble on this device?');
  const allowed = await home.app.request(`${HOME}/auth/app`, {
    method: 'POST',
    headers: { cookie, origin: HOME, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ redirect_uri: redirectUri, state: 'st', code_challenge: challenge, allow: '1' }),
    redirect: 'manual',
  });
  const back = new URL(allowed.headers.get('location')!);
  expect(back.searchParams.get('state')).toBe('st');
  return { code: back.searchParams.get('code')!, verifier, redirectUri };
}

describe('syncing with the household’s own server', () => {
  it('finds the server, signs the phone in, and keeps both in step', async () => {
    const home = server();
    createTasks(home.db, { member: home.sam, via: 'app' }, [{ title: 'Clean the gutters' }]);
    home.sync.service.stamp();
    const sams = phone(home);
    await sams.call('POST', '/device/start', { name: 'Sam' });
    await sams.call('POST', '/tasks', { title: 'Call the plumber' });

    // Typed without https://, it's found at https.
    expect((await sams.call('POST', '/sync/server/find', { address: 'home.example/' })).json).toEqual({ url: HOME });
    expect((await sams.call('POST', '/sync/server/find', { address: 'nowhere.example' })).status).toBe(400);

    const connected = await sams.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.sam.id)) });
    expect(connected.json).toMatchObject({ on: true, target: { kind: 'server', url: HOME, name: 'home.example' }, account: { email: 'sam@example.com' }, waiting: false });
    // The phone is Sam now, with the server's tasks and its own, and one set of starter groups.
    expect((await sams.call('GET', '/session')).json.member).toMatchObject({ id: home.sam.id, email: 'sam@example.com' });
    expect(await sams.titles()).toEqual(['Call the plumber', 'Clean the gutters']);
    expect((await sams.call('GET', '/groups')).json.groups).toHaveLength(6);
    expect(listTasks(home.db, home.sam, {}).map((t) => t.title).sort()).toEqual(['Call the plumber', 'Clean the gutters']);

    // A change on the phone goes up; one on the server comes down.
    await sams.call('POST', '/tasks', { title: 'Buy lightbulbs' });
    expect((await sams.call('POST', '/sync/run', {})).json).toMatchObject({ uploaded: true, error: null });
    expect(listTasks(home.db, home.sam, {}).map((t) => t.title)).toContain('Buy lightbulbs');
    createTasks(home.db, { member: home.sam, via: 'claude' }, [{ title: 'Renew the passport' }]);
    home.sync.service.stamp();
    expect((await sams.call('POST', '/sync/run', {})).json).toMatchObject({ merged: expect.any(Number), uploaded: false, error: null });
    expect(await sams.titles()).toContain('Renew the passport');
    // Nothing new on either side: the server says so without sending the household again.
    expect((await sams.call('POST', '/sync/run', {})).json).toEqual({ merged: 0, uploaded: false, error: null });

    // Ali's phone joins the same household as Ali.
    const alis = phone(home);
    await alis.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.ali.id)) });
    expect((await alis.call('GET', '/session')).json.member).toMatchObject({ id: home.ali.id });
    expect(await alis.titles()).toEqual(['Buy lightbulbs', 'Call the plumber', 'Clean the gutters', 'Renew the passport']);
  });

  it('lets a sign-in be used once, by the device that started it, going back only where it may', async () => {
    const home = server();
    const p = phone(home);
    const first = await signIn(home, home.sam.id);
    expect((await p.call('POST', '/sync/server/connect', { url: HOME, ...first, verifier: 'w'.repeat(43) })).json.error).toMatch(/expired or was already used/);
    const second = await signIn(home, home.sam.id);
    expect((await p.call('POST', '/sync/server/connect', { url: HOME, ...second })).status).toBe(200);
    expect((await p.call('POST', '/sync/server/connect', { url: HOME, ...second })).json.error).toMatch(/expired or was already used/);

    const odd = new URLSearchParams({ redirect_uri: 'https://evil.example/back', state: 's', code_challenge: 'c', code_challenge_method: 'S256' });
    const refused = await home.app.request(`${HOME}/auth/app?${odd}`, { headers: { cookie: home.cookie(home.sam.id) } });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('go back somewhere this server');
    // Not signed in on the server yet: off to sign in first, then back here.
    const fresh = new URLSearchParams({ redirect_uri: APP_RETURN, state: 's', code_challenge: 'c', code_challenge_method: 'S256' });
    const away = await home.app.request(`${HOME}/auth/app?${fresh}`, { redirect: 'manual' });
    expect(away.headers.get('location')).toBe(`/auth/login?return=${encodeURIComponent(`/auth/app?${fresh}`)}`);
    // "Not now" goes back saying so.
    const no = await home.app.request(`${HOME}/auth/app`, {
      method: 'POST',
      headers: { cookie: home.cookie(home.sam.id), origin: HOME, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ redirect_uri: APP_RETURN, state: 's', code_challenge: 'c', allow: '0' }),
      redirect: 'manual',
    });
    expect(no.headers.get('location')).toBe(`${APP_RETURN}?state=s&error=access_denied`);
  });

  it('answers devices from any address, only with a token, and stopping signs the phone out', async () => {
    const home = server();
    const p = phone(home);
    await p.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.sam.id)) });
    const preflight = await home.app.request(`${HOME}/sync/state`, { method: 'OPTIONS', headers: { origin: 'https://localhost', 'access-control-request-method': 'PUT' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect((await home.app.request(`${HOME}/sync/state`)).status).toBe(401);

    const token = (p.db.$client.prepare(`SELECT value FROM server_settings WHERE key = 'sync'`).get() as { value: string }).value;
    const { serverToken } = JSON.parse(token) as { serverToken: string };
    const got = await home.app.request(`${HOME}/sync/state`, { headers: { authorization: `Bearer ${serverToken}` } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/gzip');
    const again = await home.app.request(`${HOME}/sync/state`, { headers: { authorization: `Bearer ${serverToken}`, 'if-none-match': got.headers.get('etag')! } });
    expect(again.status).toBe(304);

    expect((await p.call('DELETE', '/sync')).json).toMatchObject({ on: false });
    expect((await home.app.request(`${HOME}/sync/state`, { headers: { authorization: `Bearer ${serverToken}` } })).status).toBe(401);
  });

  it("gives a phone with no AI model of its own the server's, which keeps the key and counts the cost", async () => {
    const home = server(fakeAi(() => ({ minutes: 10 })));
    const p = phone(home);
    await p.call('POST', '/device/start', { name: 'Sam' });
    expect((await p.call('GET', '/ai')).json).toMatchObject({ available: false, server: null });
    await p.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.sam.id)) });
    const settings = (await p.call('GET', '/ai')).json;
    expect(settings).toMatchObject({ available: true, source: 'server', server: { modelName: expect.any(String) }, settings: null });

    const answer = await ask(p.db, p.ai, {
      system: 'You estimate how long household tasks take.',
      content: 'Call the dentist',
      schema: z.object({ minutes: z.number() }),
      effort: 'low',
      maxTokens: 500,
      feature: 'estimate',
      memberId: home.sam.id,
      timezone: 'America/Chicago',
    });
    expect(answer.output).toEqual({ minutes: 10 });
    // The server counted it, for Sam, against its own cap.
    expect(home.db.select().from(aiUsage).all()).toMatchObject([{ memberId: home.sam.id, feature: 'estimate', ok: true }]);

    // An answer that doesn't fit what the phone asked for is turned down there.
    await expect(
      ask(p.db, p.ai, { system: 's', content: 'c', schema: z.object({ hours: z.number() }), effort: null, maxTokens: 500, feature: 'estimate', memberId: home.sam.id, timezone: 'America/Chicago' }),
    ).rejects.toThrow(/doesn't fit/);
  });
});

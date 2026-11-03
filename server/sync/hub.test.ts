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
import { createTasks, listTasks } from '../domain/tasks.ts';
import { memoryFiles } from '../lib/memory-files.ts';
import { createLocalApp, deviceAdopt, deviceConfig } from '../local.ts';
import { createLocalPush } from '../notify/local-push.ts';
import { APP_RETURN } from './hub.ts';
import { createServerSync } from './server.ts';
import { createSyncService, filesThroughServer } from './service.ts';
import { createGoogle } from '../lib/google.ts';

const HOME = 'https://home.example';
const serverConfig: Config = { ...config, publicUrl: HOME, basePath: '', publicOrigin: HOME, appOrigins: [HOME], devLogin: false, ai: { ...config.ai, apiKey: '' } };

/** The household's server, with Sam and Ali in it. */
function server(ai?: Ai) {
  const db = openDatabase(':memory:');
  seedStarterGroups(db);
  const sam = db.insert(members).values({ email: 'sam@example.com', name: 'Sam Lee', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  const ali = db.insert(members).values({ email: 'ali@example.com', name: 'Ali Kim', timezone: 'America/Chicago' }).returning().get();
  const sync = createServerSync({ db, config: serverConfig, google: createGoogle(serverConfig), schema: SCHEMA });
  const files = memoryFiles();
  const app = createApp({ db, config: serverConfig, oidc: createOidc(serverConfig), sync, files, ...(ai && { ai }) });
  // The network as the phone sees it: only the server answers. `asked` is every path asked for.
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${HOME}/`)) throw new TypeError('fetch failed');
    asked.push(new URL(url).pathname);
    return app.request(input instanceof Request ? input : url, init);
  }) as typeof fetch;
  return { db, sam, ali, sync, app, files, asked, fetchImpl, cookie: (memberId: string) => `almanac_session=${createSession(db, memberId, 'browser')}` };
}
type Server = ReturnType<typeof server>;

/** A phone with Amble on it, which can reach the server. */
function phone(home: Server) {
  const db = openDatabase(':memory:');
  const cfg = deviceConfig('https://localhost', '', 'America/Chicago');
  const files = memoryFiles();
  const sync = createSyncService({ db, schema: SCHEMA, fetchImpl: home.fetchImpl, adopt: deviceAdopt(db, cfg), files });
  // No model of its own: it uses the server's, once it syncs with one.
  const ai = createAi(cfg, db, home.fetchImpl, { seal: (k) => k, open: (k) => k }, () => sync.remoteAi());
  const app = createLocalApp({
    db,
    config: cfg,
    ai,
    push: createLocalPush(db, async () => true),
    files: filesThroughServer(files, sync, cfg.maxFileBytes),
    sync,
    fetchImpl: home.fetchImpl,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`https://localhost/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return { db, sync, ai, app, files, call, titles: async () => ((await call('GET', '/tasks')).json.tasks as { title: string }[]).map((t) => t.title).sort() };
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
    expect((await sams.call('POST', '/sync/server/find', { address: 'home.example/' })).json).toEqual({ url: HOME, pairing: true, signIn: null });
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

  it("keeps who's an admin when someone else's phone changes it", async () => {
    const home = server();
    const alis = phone(home);
    await alis.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.ali.id)) });
    // Ali's own copy, edited by hand: Ali an admin, Sam not, and a new admin brought in.
    alis.db.$client.prepare(`UPDATE members SET role = CASE id WHEN ? THEN 'admin' ELSE 'member' END`).run(home.ali.id);
    alis.db.$client.prepare(`INSERT INTO members (id, email, name, timezone, role) VALUES ('m-new', 'new@example.com', 'New', 'America/Chicago', 'admin')`).run();
    await alis.call('POST', '/tasks', { title: 'Water the plants' });
    expect((await alis.call('POST', '/sync/run', {})).json).toMatchObject({ error: null });

    const roles = (db: typeof home.db) => Object.fromEntries(db.select({ email: members.email, role: members.role }).from(members).all().map((m) => [m.email, m.role]));
    // The task made it; the roles didn't, and Ali's phone has the server's back.
    expect(listTasks(home.db, home.sam, {}).map((t) => t.title)).toContain('Water the plants');
    expect(roles(home.db)).toEqual({ 'sam@example.com': 'admin', 'ali@example.com': 'member', 'new@example.com': 'member' });
    await alis.call('POST', '/sync/run', {});
    expect(roles(alis.db)).toEqual({ 'sam@example.com': 'admin', 'ali@example.com': 'member', 'new@example.com': 'member' });
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

  it('shares files on tasks through the server: sent after a round, fetched the first time someone opens them', async () => {
    const home = server();
    const sams = phone(home);
    await sams.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.sam.id)) });
    const { task } = (await sams.call('POST', '/tasks', { title: 'Fix the dishwasher' })).json;
    const manual = new TextEncoder().encode('Hold the start button for three seconds.');
    const added = await sams.app.request(`https://localhost/api/tasks/${task.id}/files?name=manual.txt`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: manual });
    expect(added.status).toBe(201);
    const [sha256] = [...sams.files.stored.keys()];

    await sams.call('POST', '/sync/run', {});
    expect(home.files.stored.get(sha256!)).toEqual(manual);
    // Known to be there now: the next round doesn't ask about it again.
    home.asked.length = 0;
    await sams.call('POST', '/sync/run', {});
    expect(home.asked.filter((p) => p.startsWith('/sync/files'))).toEqual([]);

    // Ali's phone has the file's details from the household, and the bytes the first time they open it.
    const alis = phone(home);
    await alis.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.ali.id)) });
    const { files } = (await alis.call('GET', `/tasks/${task.id}`)).json.task as { files: { id: string }[] };
    const opened = await alis.app.request(`https://localhost/api/files/${files[0]!.id}`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('Hold the start button for three seconds.');
    expect(alis.files.stored.get(sha256!)).toEqual(manual);

    // The server keeps only bytes a file on a task points at, and gives out only those.
    const token = (JSON.parse((alis.db.$client.prepare(`SELECT value FROM server_settings WHERE key = 'sync'`).get() as { value: string }).value) as { serverToken: string }).serverToken;
    const auth = { authorization: `Bearer ${token}` };
    const stray = 'f'.repeat(64);
    expect((await home.app.request(`${HOME}/sync/files/${stray}`, { method: 'PUT', headers: auth, body: 'something else' })).status).toBe(404);
    expect((await home.app.request(`${HOME}/sync/files/${stray}`, { headers: auth })).status).toBe(404);
    expect((await home.app.request(`${HOME}/sync/files/${sha256}`)).status).toBe(401);
    // Bytes sent as a file they aren't are turned down.
    home.files.stored.delete(sha256!);
    expect((await home.app.request(`${HOME}/sync/files/${sha256}`, { method: 'PUT', headers: auth, body: 'not the manual' })).status).toBe(400);
    expect(home.files.stored.has(sha256!)).toBe(false);
  });

  it("lets the app show the server's own settings, and an admin set the household's AI model there", async () => {
    const home = server();
    const sams = phone(home);
    await sams.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.sam.id)) });
    const before = (await sams.call('GET', '/sync/server/settings')).json;
    expect(before).toMatchObject({ url: HOME, me: { email: 'sam@example.com', role: 'admin' }, mcpUrl: `${HOME}/mcp`, connections: [], ai: { available: false } });

    // Sam sets the household's model on the server, from the phone; the phone uses it from the next round.
    const saved = await sams.call('PUT', '/sync/server/settings/ai', { provider: 'custom', model: 'qwen3:4b', baseUrl: 'http://ollama.lan:11434/v1', effort: 'default', monthlyCapUsd: 5, check: false });
    expect(saved.json).toEqual({ ok: true, ms: null });
    expect((await sams.call('GET', '/sync/server/settings')).json.ai).toMatchObject({ available: true, modelName: 'qwen3:4b', source: 'settings', settings: { baseUrl: 'http://ollama.lan:11434/v1' } });
    await sams.call('POST', '/sync/run', {});
    expect((await sams.call('GET', '/ai')).json).toMatchObject({ available: true, source: 'server' });

    // Ali isn't an admin: Ali sees the model but can't change it, or see how it's set up.
    const alis = phone(home);
    await alis.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.ali.id)) });
    expect((await alis.call('GET', '/sync/server/settings')).json).toMatchObject({ me: { role: 'member' }, ai: { available: true, settings: null }, drive: null });
    expect((await alis.call('DELETE', '/sync/server/settings/ai')).json.error).toMatch(/Only an admin/);
    expect((await alis.call('DELETE', '/sync/server/settings/connections/nope')).json.error).toMatch(/already gone/);

    // Without a server, there's nothing to ask.
    const alone = phone(home);
    await alone.call('POST', '/device/start', { name: 'Kim' });
    expect((await alone.call('GET', '/sync/server/settings')).json.error).toMatch(/doesn't sync with a server/);
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

  it("streams smart add's cards to the phone as the server's model writes them", async () => {
    const none = { mode: 'none', every: 0, unit: 'week', weekdays: [], day: 0, nth: 0, weekday: 0, month: 0, months: [] };
    const task = (title: string) => ({
      kind: 'add_task',
      task: { title, notes: '', group: '', for: '', planned: '', due: '', time_of_day: '', must_do: false, estimate_minutes: 10, steps: [], links: [], repeat: none, remind: '' },
    });
    const home = server(fakeAi(() => ({ items: [task('Call the dentist'), task('Mow the lawn')], unclear: '' })));
    const p = phone(home);
    await p.call('POST', '/device/start', { name: 'Sam' });
    await p.call('POST', '/sync/server/connect', { url: HOME, ...(await signIn(home, home.sam.id)) });

    const res = await p.app.request('https://localhost/api/smart-add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'call the dentist and mow the lawn', stream: true }),
    });
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => Object.keys(l)[0])).toEqual(['proposal', 'proposal', 'result']);
    expect(lines[0].proposal.task.title).toBe('Call the dentist');
    expect(lines[2].result.proposals).toEqual([lines[0].proposal, lines[1].proposal]);
    expect(home.db.select().from(aiUsage).all()).toMatchObject([{ feature: 'smart_add', ok: true }]);
  });
});

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAi } from '../ai/client.ts';
import { createApp } from '../app.ts';
import { makeCode } from '../auth/pairing.ts';
import { createOidc } from '../auth/oidc.ts';
import { config, type Config } from '../config.ts';
import { openDatabase, SCHEMA } from '../db/index.ts';
import { members, pairCodes, tasks } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { createTasks, listTasks } from '../domain/tasks.ts';
import { createGoogle } from '../lib/google.ts';
import { memoryFiles } from '../lib/memory-files.ts';
import { createLocalApp, deviceAdopt, deviceConfig } from '../local.ts';
import { createLocalPush } from '../notify/local-push.ts';
import { createFakeDrive, type FakeDrive } from './fake-drive.ts';
import { createServerSync } from './server.ts';
import { createSyncService, JOIN_PROPERTY, SERVER_PROPERTY } from './service.ts';

const HOME = 'https://home.example';
// No sign-in provider: codes are the only way in.
const serverConfig: Config = {
  ...config,
  publicUrl: HOME,
  basePath: '',
  publicOrigin: HOME,
  appOrigins: [HOME],
  devLogin: false,
  secret: 'server-secret',
  oidc: { ...config.oidc, clientId: '', clientSecret: '' },
  ai: { ...config.ai, apiKey: '' },
};

/** A household's new server, with nobody in it yet. */
function server() {
  const db = openDatabase(':memory:');
  seedStarterGroups(db);
  const sync = createServerSync({ db, config: serverConfig, google: createGoogle(serverConfig), schema: SCHEMA });
  const app = createApp({ db, config: serverConfig, oidc: createOidc(serverConfig), sync, files: memoryFiles() });
  return { db, app, sync };
}
type Server = ReturnType<typeof server>;

/** A phone with Amble on it, which reaches the server, and Google Drive if it's given one. */
function phone(home: Server, drive?: FakeDrive, token = '') {
  const db = openDatabase(':memory:');
  const cfg = deviceConfig('https://localhost', '', 'America/Chicago');
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${HOME}/`)) return home.app.request(input instanceof Request ? input : url, init);
    if (drive) return drive.fetch(input, init);
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const sync = createSyncService({ db, schema: SCHEMA, fetchImpl, adopt: deviceAdopt(db, cfg) });
  const app = createLocalApp({
    db,
    config: cfg,
    ai: createAi(cfg, db, fetchImpl, { seal: (k) => k, open: (k) => k }),
    push: createLocalPush(db, async () => true),
    files: memoryFiles(),
    sync,
    fetchImpl,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`https://localhost/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return {
    db,
    call,
    me: async () => (await call('GET', '/session')).json.member,
    titles: async () => ((await call('GET', '/tasks')).json.tasks as { title: string }[]).map((t) => t.title).sort(),
    pair: (code: string, name?: string) => call('POST', '/sync/server/pair', { url: HOME, code, name }),
    code: async (whom: 'me' | 'someone') => (await call('POST', '/sync/server/settings/codes', { for: whom })).json as { code: string; link: string },
    connect: (how: Record<string, unknown>) => call('POST', '/sync/connect', { token, ...how }),
    run: () => call('POST', '/sync/run', token ? { token } : {}),
  };
}

const adminCode = (home: Server) => makeCode(home.db, { kind: 'invite', role: 'admin', by: null }).code;
/** Every task on the server, whoever it's for. */
const onServer = (home: Server) => home.db.select({ title: tasks.title }).from(tasks).all().map((t) => t.title).sort();

describe('getting into a server with a code', () => {
  it("lets the first phone in as the admin with the setup script's code, and that phone brings in the next", async () => {
    const home = server();
    const jos = phone(home);
    await jos.call('POST', '/device/start', { name: 'Jo' });
    await jos.call('POST', '/tasks', { title: 'Fix the fence' });
    const code = adminCode(home);
    expect((await jos.pair(code)).json).toMatchObject({ on: true, target: { kind: 'server', url: HOME } });
    // The server has Jo now, as the phone made them, and an admin.
    const jo = await jos.me();
    expect(home.db.select().from(members).where(eq(members.id, jo.id)).get()).toMatchObject({ name: 'Jo', role: 'admin' });
    expect(listTasks(home.db, jo, {}).map((t) => t.title)).toEqual(['Fix the fence']);
    // Each code works once.
    expect((await phone(home).pair(code, 'Someone')).json.error).toMatch(/doesn't work/);

    // A code for someone new, typed in on a new phone that has nobody on it yet: it asks for a name first.
    const invite = await jos.code('someone');
    expect(invite.link).toBe(`${HOME}/?join=${invite.code}`);
    const kais = phone(home);
    expect((await kais.pair(invite.code)).json).toMatchObject({ needName: true });
    expect((await kais.pair(invite.code, 'Kai')).json).toMatchObject({ on: true });
    expect(await kais.me()).toMatchObject({ name: 'Kai', role: 'member' });
    expect(await kais.titles()).toEqual(['Fix the fence']);
  });

  it("signs another of someone's devices in as them, and a browser on the server's pages", async () => {
    const home = server();
    const jos = phone(home);
    await jos.call('POST', '/device/start', { name: 'Jo' });
    await jos.pair(adminCode(home));
    const jo = await jos.me();

    const laptop = phone(home);
    expect((await laptop.pair((await jos.code('me')).code)).json).toMatchObject({ on: true });
    expect((await laptop.me()).id).toBe(jo.id);

    // A browser, for the server's own page or an assistant's consent.
    const { code } = await jos.code('me');
    const signedIn = await home.app.request(`${HOME}/auth/code`, {
      method: 'POST',
      headers: { origin: HOME, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: code.toLowerCase().replace('-', ' '), return: '/server' }),
      redirect: 'manual',
    });
    expect(signedIn.headers.get('location')).toBe('/server');
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await home.app.request(`${HOME}/server`, { headers: { cookie } })).text();
    expect(page).toContain('Signed in as Jo');
    // Only an admin's code brings in someone new.
    const kais = phone(home);
    await kais.pair((await jos.code('someone')).code, 'Kai');
    expect((await kais.call('POST', '/sync/server/settings/codes', { for: 'someone' })).json.error).toMatch(/Only an admin/);
  });

  it("sends sign-in to codes when there's no sign-in provider, and turns away a run of wrong ones", async () => {
    const home = server();
    const login = await home.app.request(`${HOME}/auth/login?return=/server`, { redirect: 'manual' });
    expect(login.headers.get('location')).toBe('/auth/signin?return=%2Fserver');
    const signin = await home.app.request(`${HOME}/auth/signin`);
    expect(await signin.text()).toContain('ABCD-EFGH');
    expect(signin.headers.get('content-security-policy')).toContain("default-src 'none'");

    const p = phone(home);
    for (let i = 0; i < 10; i++) expect((await p.pair('WRNG-CODE', 'X')).status).toBe(400);
    // Even the right code waits now.
    expect((await p.pair(adminCode(home), 'X')).json.error).toMatch(/Too many/);

    // Through a proxy, the address it saw counts, not one the caller made up for each guess.
    const guess = (claimed: string, real: string) =>
      home.app.request(`${HOME}/sync/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `${claimed}, ${real}` },
        body: JSON.stringify({ code: 'WRNG-CODE', name: 'X' }),
      });
    for (let i = 0; i < 10; i++) expect((await guess(`203.0.113.${i}`, '100.64.0.9')).status).toBe(400);
    expect((await guess('203.0.113.99', '100.64.0.9')).status).toBe(429);
    expect((await guess('203.0.113.99', '100.64.0.10')).status).toBe(400);
  });

  it('runs out', async () => {
    const home = server();
    const old = makeCode(home.db, { kind: 'invite', role: 'member', by: null }, Date.now() - 11 * 60_000);
    expect((await phone(home).pair(old.code, 'Kai')).json.error).toMatch(/doesn't work/);
    expect(home.db.select().from(pairCodes).all()).toHaveLength(1);
  });
});

describe('a household moving from Google Drive to its own server', () => {
  it('keeps the Drive file in step from the first phone to move, and lets the rest follow with a tap', async () => {
    const home = server();
    const drive = createFakeDrive();
    const samToken = drive.user('sam@example.com', 'Sam Lee');
    const aliToken = drive.user('ali@example.com', 'Ali Kim');
    const sams = phone(home, drive, samToken);
    const alis = phone(home, drive, aliToken);
    await sams.call('POST', '/device/start', { name: 'Sam' });
    const fileId = (await sams.connect({ mode: 'create', name: "Sam's Amble household" })).json.target.fileId;
    await sams.call('POST', '/sync/share', { token: samToken, email: 'ali@example.com', name: 'Ali' });
    await sams.run();
    drive.pick('ali@example.com', fileId);
    expect((await alis.connect({ mode: 'join', fileId })).status).toBe(200);
    await alis.call('POST', '/tasks', { title: 'Water the plants' });
    await alis.run();
    await sams.run();

    // Sam moves first, with the setup script's code, and brings the household with them.
    expect((await sams.pair(adminCode(home))).json).toMatchObject({ target: { kind: 'server' }, bridge: { name: "Sam's Amble household", account: 'sam@example.com' } });
    expect(onServer(home)).toEqual(['Water the plants']);

    // Ali, still on Drive, adds something; Sam's next round carries it to the server, and notes the
    // server and its invite on the file.
    await alis.call('POST', '/tasks', { title: 'Book the vet' });
    await alis.run();
    expect((await sams.run()).json.error).toBeNull();
    expect(onServer(home)).toContain('Book the vet');
    const noted = drive.files().find((f) => f.id === fileId)!.properties;
    expect(noted[SERVER_PROPERTY]).toBe(HOME);
    expect(noted[JOIN_PROPERTY]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // Something new on the server reaches Ali through the file meanwhile.
    createTasks(home.db, { member: home.db.select().from(members).where(eq(members.email, 'sam@example.com')).get()!, via: 'claude' }, [{ title: 'Renew the passport' }]);
    home.sync.service.stamp();
    await sams.run();
    await alis.run();
    expect(await alis.titles()).toContain('Renew the passport');

    // Ali's phone sees where the household went, and moves with the invite, as Ali.
    const status = (await alis.call('GET', '/sync')).json;
    expect(status).toMatchObject({ householdServer: HOME, householdJoin: noted[JOIN_PROPERTY] });
    expect((await alis.pair(status.householdJoin)).json).toMatchObject({ target: { kind: 'server' }, account: { email: 'ali@example.com' } });
    expect(await alis.titles()).toEqual(['Book the vet', 'Renew the passport', 'Water the plants']);

    // Everyone's moved: Sam stops, and the invite comes off the file and stops working.
    expect((await sams.call('DELETE', '/sync/bridge', { token: samToken })).json.bridge).toBeNull();
    expect(drive.files().find((f) => f.id === fileId)!.properties[JOIN_PROPERTY]).toBeUndefined();
    expect((await phone(home).pair(status.householdJoin, 'Someone')).json.error).toMatch(/doesn't work/);
  });
});

import { describe, expect, it } from 'vitest';
import { createAi } from '../ai/client.ts';
import { createGoogle } from '../calendar/google.ts';
import { createCalendarSync } from '../calendar/sync.ts';
import { openDatabase } from '../db/index.ts';
import type { FileStore } from '../domain/files.ts';
import { createLocalApp, deviceAdopt, deviceConfig } from '../local.ts';
import { createLocalPush } from '../notify/local-push.ts';
import { createFakeDrive, type FakeDrive } from './fake-drive.ts';
import { createSyncService } from './service.ts';

const SCHEMA = '0010_sync';
const ORIGIN = 'https://amble.example';

const noFiles: FileStore = {
  save: async () => ({ sha256: '0'.repeat(64), size: 1 }),
  get: async () => null,
  sweep: async () => 0,
};

/** A phone or laptop running Amble with no server, syncing through the fake Drive. */
function device(drive: FakeDrive, token: string) {
  const db = openDatabase(':memory:');
  const config = deviceConfig(ORIGIN, '', 'America/Chicago');
  const sync = createSyncService({ db, schema: SCHEMA, fetchImpl: drive.fetch, adopt: deviceAdopt(db, config) });
  const app = createLocalApp({
    db,
    config,
    ai: createAi(config, db, fetch, { seal: (k) => k, open: (k) => k }),
    calendar: createCalendarSync({ db, config, google: createGoogle(config) }),
    push: createLocalPush(db, async () => true),
    files: noFiles,
    sync,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${ORIGIN}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return {
    db,
    sync,
    call,
    connect: (how: Record<string, unknown>) => call('POST', '/sync/connect', { token, ...how }),
    run: () => call('POST', '/sync/run', { token }),
    titles: async () => ((await call('GET', '/tasks')).json.tasks as { title: string }[]).map((t) => t.title).sort(),
    me: async () => (await call('GET', '/session')).json.member,
  };
}

describe('sync through Google Drive', () => {
  it("backs one person's data up to their Drive and brings it to their next device", async () => {
    const drive = createFakeDrive();
    const sam = drive.user('sam@example.com', 'Sam Lee');
    const phone = device(drive, sam);
    await phone.call('POST', '/device/start', { name: 'Sam' });
    await phone.call('POST', '/tasks', { title: 'Renew the car tags' });
    const connected = await phone.connect({ mode: 'personal' });
    expect(connected.json).toMatchObject({ on: true, target: { kind: 'personal' }, account: { email: 'sam@example.com' }, waiting: false });
    expect(drive.files()).toEqual([expect.objectContaining({ name: 'almanac.state', owner: 'sam@example.com', appData: true })]);
    // The phone's member now has Sam's real address.
    expect((await phone.me()).email).toBe('sam@example.com');

    // A new laptop, never set up, starts from what's in Drive and is Sam straight away.
    const laptop = device(drive, sam);
    expect((await laptop.me())).toBeNull();
    expect((await laptop.connect({ mode: 'personal' })).status).toBe(200);
    expect((await laptop.me()).id).toBe((await phone.me()).id);
    expect(await laptop.titles()).toEqual(['Renew the car tags']);
    // One set of starter groups, not two.
    expect((await laptop.call('GET', '/groups')).json.groups).toHaveLength(6);

    await laptop.call('POST', '/tasks', { title: 'Book the dentist' });
    expect((await laptop.call('GET', '/sync')).json.waiting).toBe(true);
    expect((await laptop.run()).json).toMatchObject({ uploaded: true, error: null });
    expect((await phone.run()).json).toMatchObject({ merged: expect.any(Number), error: null });
    expect(await phone.titles()).toEqual(['Book the dentist', 'Renew the car tags']);
  });

  it('shares a household file, and someone who picks it joins with what they had', async () => {
    const drive = createFakeDrive();
    const sam = drive.user('sam@example.com', 'Sam Lee');
    const ali = drive.user('ali@example.com', 'Ali Kim');
    const samPhone = device(drive, sam);
    await samPhone.call('POST', '/device/start', { name: 'Sam' });
    await samPhone.call('POST', '/tasks', { title: 'Fix the gate' });
    const made = await samPhone.connect({ mode: 'create', name: 'Lee-Kim household' });
    expect(made.json.target).toMatchObject({ kind: 'household', name: 'Lee-Kim household', owner: 'sam@example.com' });
    const fileId = made.json.target.fileId;

    expect((await samPhone.call('POST', '/sync/share', { token: sam, email: 'Ali@Example.com', name: 'Ali' })).status).toBe(200);
    expect(drive.sent).toEqual([expect.objectContaining({ to: 'ali@example.com', fileId })]);
    // Ali is in the household already, so tasks can go to them.
    const people = (await samPhone.call('GET', '/members')).json.members.map((m: { email: string }) => m.email).sort();
    expect(people).toEqual(['ali@example.com', 'sam@example.com']);
    await samPhone.run();

    // Ali has been using Amble alone, with a task in their own Home group.
    const aliPhone = device(drive, ali);
    await aliPhone.call('POST', '/device/start', { name: 'Ali' });
    const home = (await aliPhone.call('GET', '/groups')).json.groups.find((g: { name: string }) => g.name === 'Home');
    await aliPhone.call('POST', '/tasks', { title: 'Water the tomatoes', groupId: home.id });

    // Without picking the file in Google's picker, Amble can't open it.
    expect((await aliPhone.connect({ mode: 'join', fileId })).json.error).toMatch(/isn't an Amble household file/);
    drive.pick('ali@example.com', fileId);
    expect((await aliPhone.connect({ mode: 'join', fileId })).status).toBe(200);

    const aliMember = await aliPhone.me();
    const samsAli = (await samPhone.call('GET', '/members')).json.members.find((m: { email: string }) => m.email === 'ali@example.com');
    expect(aliMember.id).toBe(samsAli.id);
    // Ali's Home folded into the household's Home, task and all.
    const groupsNow = (await aliPhone.call('GET', '/groups')).json.groups.map((g: { name: string }) => g.name);
    expect(groupsNow.filter((n: string) => n === 'Home')).toHaveLength(1);
    expect(await aliPhone.titles()).toEqual(['Fix the gate', 'Water the tomatoes']);

    await samPhone.run();
    const tomatoes = (await samPhone.call('GET', '/tasks?q=tomatoes')).json.tasks[0];
    expect(tomatoes).toMatchObject({ groupName: 'Home', createdById: aliMember.id, createdByName: 'Ali' });
  });

  it("sends a change again when another device wrote over the file without it", async () => {
    const drive = createFakeDrive();
    const sam = drive.user('sam@example.com', 'Sam');
    const a = device(drive, sam);
    await a.call('POST', '/device/start', { name: 'Sam' });
    await a.connect({ mode: 'personal' });
    const b = device(drive, sam);
    await b.connect({ mode: 'personal' });

    // Both change things; A writes first, then B writes a copy that hasn't seen A's change.
    await a.call('POST', '/tasks', { title: 'From A' });
    await b.call('POST', '/tasks', { title: 'From B' });
    const bStateBefore = b.sync.status();
    expect(bStateBefore.waiting).toBe(true);
    await a.run();
    // B's round sees the new file, merges A's change, and writes both.
    await b.run();
    await a.run();
    expect(await a.titles()).toEqual(['From A', 'From B']);
    expect(await b.titles()).toEqual(['From A', 'From B']);
    expect((await a.call('GET', '/sync')).json.waiting).toBe(false);
    expect((await b.call('GET', '/sync')).json.waiting).toBe(false);
  });

  it('says when Google wants a fresh sign-in, and stops cleanly', async () => {
    const drive = createFakeDrive();
    const sam = drive.user('sam@example.com', 'Sam');
    const a = device(drive, sam);
    await a.call('POST', '/device/start', { name: 'Sam' });
    await a.connect({ mode: 'personal' });
    expect((await a.call('POST', '/sync/run', { token: 'token-expired-long-ago' })).json).toMatchObject({ error: 'Google needs you to sign in again.' });
    expect((await a.call('GET', '/sync')).json.error).toBe('Google needs you to sign in again.');
    expect((await a.call('DELETE', '/sync')).json).toMatchObject({ on: false });
    // Changes after that aren't recorded for sync.
    await a.call('POST', '/tasks', { title: 'Offline only' });
    expect(a.db.$client.prepare('SELECT count(*) AS n FROM sync_cells').get()).toEqual({ n: 0 });
  });
});

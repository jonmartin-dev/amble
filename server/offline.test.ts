import { beforeEach, describe, expect, it } from 'vitest';
import { createAi } from './ai/client.ts';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { createSession } from './auth/sessions.ts';
import { config, type Config } from './config.ts';
import { openDatabase, type Db } from './db/index.ts';
import { members, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import { addDays, planningDate } from './lib/dates.ts';
import { madeAt } from './requests.ts';

const ORIGIN = 'https://almanac.test';
const testConfig: Config = {
  ...config,
  production: false,
  publicUrl: ORIGIN,
  basePath: '',
  publicOrigin: ORIGIN,
  adminEmails: ['jon@example.com'],
  allowedEmails: ['jon@example.com', 'alex@example.com'],
  devLogin: false,
  oidc: { ...config.oidc, clientId: '', clientSecret: '' },
  ai: { ...config.ai, apiKey: '' },
};

let db: Db;
let app: ReturnType<typeof createApp>;
let jon: Member;
let alex: Member;
let today: string;

/** Calls the API as a member. `late` sends the change as one the app queued that long ago. */
function as(member: Member) {
  const cookie = `almanac_session=${createSession(db, member.id, 'test')}`;
  return async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}/api${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true', json: res.status === 204 ? null : await res.json() };
  };
}

const late = (minutes: number, key = crypto.randomUUID()) => ({ 'almanac-age': String(minutes * 60_000), 'idempotency-key': key });

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  alex = db.insert(members).values({ email: 'alex@example.com', name: 'Alex', timezone: 'America/Chicago' }).returning().get();
  app = createApp({ db, config: testConfig, oidc: createOidc(testConfig), ai: createAi(testConfig) });
  today = planningDate(jon);
});

describe('queued writes', () => {
  it('reads how long ago a change was made, ignoring ones sent straight away', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(madeAt(undefined, now)).toBeUndefined();
    expect(madeAt('500', now)).toBeUndefined();
    expect(madeAt('nonsense', now)).toBeUndefined();
    expect(madeAt(String(10 * 60_000), now)?.toISOString()).toBe('2026-10-14T11:50:00.000Z');
  });

  it('applies a change once when the app sends it twice', async () => {
    const api = as(jon);
    const id = crypto.randomUUID();
    const headers = { 'idempotency-key': 'k1' };
    const first = await api('PATCH', '/tasks/x', undefined, headers);
    expect(first.status).toBe(400); // no such task: answered, and that answer is kept too
    const created = await api('POST', '/tasks', { id, title: 'Call the vet', subtasks: ['Find the number'] }, { 'idempotency-key': 'k2' });
    expect(created.status).toBe(201);
    expect(created.json.task.id).toBe(id);

    const step = await api('PATCH', `/tasks/${id}`, { addSubtasks: ['Ask about shots'] }, { 'idempotency-key': 'k3' });
    const again = await api('PATCH', `/tasks/${id}`, { addSubtasks: ['Ask about shots'] }, { 'idempotency-key': 'k3' });
    expect(again.replayed).toBe(true);
    expect(again.json).toEqual(step.json);
    const task = (await api('GET', `/tasks/${id}`)).json.task;
    expect(task.subtasks.map((s: { title: string }) => s.title)).toEqual(['Find the number', 'Ask about shots']);

    // The same id without a key (an older app) still makes only one task.
    expect((await api('POST', '/tasks', { id, title: 'Call the vet' })).json.task.id).toBe(id);
    expect((await api('GET', '/tasks?q=vet')).json.tasks).toHaveLength(1);
  });

  it("keeps ids the app chose for steps, links and list items", async () => {
    const api = as(jon);
    const id = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    await api('POST', '/tasks', { id, title: 'Plan the trip', subtasks: [{ id: stepId, title: 'Book the cabin' }], links: [{ id: linkId, url: 'https://example.com/cabin' }] });
    await api('PATCH', `/tasks/${id}`, { checkSubtasks: [stepId], removeLinks: [linkId] });
    const task = (await api('GET', `/tasks/${id}`)).json.task;
    expect(task.subtasks).toEqual([{ id: stepId, title: 'Book the cabin', done: true }]);
    expect(task.links).toEqual([]);

    const groups = (await api('GET', '/groups')).json.groups;
    const list = groups.find((g: { kind: string }) => g.kind === 'list');
    const itemId = crypto.randomUUID();
    expect((await api('POST', `/lists/${list.id}/items`, { id: itemId, name: 'Eggs' })).json.item.id).toBe(itemId);
  });

  it("refuses a change made while someone else was signed in on the phone", async () => {
    const res = await as(alex)('POST', '/tasks', { title: 'Not mine' }, { 'almanac-member': jon.id });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('other-member');
  });

  it('answers "in progress" while the first attempt is still running', async () => {
    const api = as(jon);
    const { appliedRequests } = await import('./db/schema.ts');
    db.insert(appliedRequests).values({ memberId: jon.id, key: 'busy' }).run();
    const res = await api('POST', '/tasks', { title: 'Wait' }, { 'idempotency-key': 'busy' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('in-progress');
  });
});

describe('the later change wins', () => {
  async function task(fields: Record<string, unknown> = {}) {
    return (await as(jon)('POST', '/tasks', { title: 'Clean the gutters', ...fields })).json.task as { id: string };
  }

  it('leaves a field alone when someone changed it after a late change was made', async () => {
    const { id } = await task({ plannedDate: today });
    // Alex moves it now; Jon moved it 30 minutes ago while offline, and that arrives after.
    await as(alex)('POST', `/tasks/${id}/move`, { plannedDate: addDays(today, 3) });
    const res = await as(jon)('POST', `/tasks/${id}/move`, { plannedDate: addDays(today, 1) }, late(30));
    expect(res.json.task.plannedDate).toBe(addDays(today, 3));
  });

  it('still applies other fields from the same late change', async () => {
    const { id } = await task();
    await as(alex)('PATCH', `/tasks/${id}`, { title: 'Clean the gutters before the rain' });
    const res = await as(jon)('PATCH', `/tasks/${id}`, { title: 'Clean gutters', mustDo: true, addSubtasks: ['Ladder'] }, late(10));
    expect(res.json.task).toMatchObject({ title: 'Clean the gutters before the rain', mustDo: true });
    expect(res.json.task.subtasks.map((s: { title: string }) => s.title)).toEqual(['Ladder']);
  });

  it('applies a late change when nothing changed after it, stamping when it was made', async () => {
    const { id } = (await as(jon)('POST', '/tasks', { title: 'Clean the gutters', plannedDate: today }, late(120))).json.task;
    // Alex changed it an hour ago; Jon finished it offline 20 minutes ago.
    await as(alex)('PATCH', `/tasks/${id}`, { notes: 'Use the long ladder' }, late(60));
    const before = Date.now();
    const res = await as(jon)('POST', `/tasks/${id}/complete`, { done: true }, late(20));
    expect(res.json.task.status).toBe('done');
    const doneAt = Date.parse(res.json.task.completedAt);
    expect(doneAt).toBeGreaterThan(before - 21 * 60_000);
    expect(doneAt).toBeLessThan(before - 19 * 60_000);
    const feed = (await as(jon)('GET', `/tasks/${id}/activity`)).json.entries;
    expect(feed.map((e: { action: string }) => e.action)).toEqual(['task.completed', 'task.updated', 'task.created']);
  });

  it("applies a person's own queued changes in order", async () => {
    const { id } = await task();
    const api = as(jon);
    await api('POST', `/tasks/${id}/move`, { plannedDate: addDays(today, 1) }, late(30));
    const res = await api('POST', `/tasks/${id}/move`, { plannedDate: addDays(today, 2) }, late(20));
    expect(res.json.task.plannedDate).toBe(addDays(today, 2));
  });

  it("doesn't undo a completion someone reopened afterwards, or fail on steps that are gone", async () => {
    const { id } = await task({ subtasks: ['Bucket'] });
    const api = as(jon);
    const stepId = (await api('GET', `/tasks/${id}`)).json.task.subtasks[0].id;
    await as(alex)('PATCH', `/tasks/${id}`, { removeSubtasks: [stepId] });
    expect((await api('PATCH', `/tasks/${id}`, { checkSubtasks: [stepId] }, late(5))).status).toBe(200);
    await api('POST', `/tasks/${id}/complete`, { done: true });
    await as(alex)('POST', `/tasks/${id}/complete`, { done: false });
    expect((await api('POST', `/tasks/${id}/archive`, {}, late(5))).json.task.status).toBe('open');
  });

  it('leaves list items alone that someone changed after a late change', async () => {
    const api = as(jon);
    const groups = (await api('GET', '/groups')).json.groups;
    const list = groups.find((g: { kind: string }) => g.kind === 'list');
    const milk = (await api('POST', `/lists/${list.id}/items`, { name: 'Milk' }, late(60))).json.item;
    const eggs = (await api('POST', `/lists/${list.id}/items`, { name: 'Eggs' }, late(60))).json.item;
    // Alex bought milk just now; Jon checked off both 15 minutes ago in a store with no signal...
    await as(alex)('POST', `/lists/${list.id}/items/${milk.id}/check`, { checked: true });
    await as(alex)('POST', `/lists/${list.id}/items`, { name: 'Milk', quantity: '2' });
    await api('POST', `/lists/${list.id}/items/${milk.id}/check`, { checked: true }, late(15));
    await api('POST', `/lists/${list.id}/items/${eggs.id}/check`, { checked: true }, late(15));
    const after = (await api('GET', `/lists/${list.id}`)).json;
    // ...so milk stays on the list Alex put it back on, and eggs come off.
    expect(after.open.map((i: { name: string }) => i.name)).toEqual(['Milk']);
    expect(after.checked.map((i: { name: string }) => i.name)).toEqual(['Eggs']);

    // A late reset brings back only what was checked off before it was made.
    await api('POST', `/lists/${list.id}/reset`, {}, late(30));
    expect((await api('GET', `/lists/${list.id}`)).json.open.map((i: { name: string }) => i.name)).toEqual(['Milk']);
    await api('POST', `/lists/${list.id}/reset`, {});
    expect((await api('GET', `/lists/${list.id}`)).json.open).toHaveLength(2);
  });
});

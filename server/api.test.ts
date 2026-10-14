import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { createSession } from './auth/sessions.ts';
import { config, type Config } from './config.ts';
import { openDatabase, type Db } from './db/index.ts';
import { activity, members, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import { addDays, planningDate } from './lib/dates.ts';

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
};

let db: Db;
let app: ReturnType<typeof createApp>;
let jon: Member;
let today: string;
const cookies = new Map<string, string>();

function as(member: Member) {
  if (!cookies.has(member.id)) cookies.set(member.id, `almanac_session=${createSession(db, member.id, 'test')}`);
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await app.request(`${ORIGIN}/api${path}`, {
      method,
      headers: { cookie: cookies.get(member.id)!, origin: ORIGIN, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, data: unknown = {}) => call('POST', path, data),
    patch: (path: string, data: unknown) => call('PATCH', path, data),
    del: (path: string) => call('DELETE', path),
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  cookies.clear();
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  app = createApp({ db, config: testConfig, oidc: createOidc(testConfig) });
  today = planningDate(jon);
});

describe('tasks API', () => {
  it('creates, plans, completes and archives tasks, logging each change via app', async () => {
    const api = as(jon);
    const { json: groups } = await api.get('/groups');
    const home = groups.groups.find((g: { name: string }) => g.name === 'Home');

    const created = await api.post('/tasks', { title: 'Mow the lawn', groupId: home.id, plannedDate: today, estimateMinutes: 45 });
    expect(created.status).toBe(201);
    expect(created.json.task).toMatchObject({ title: 'Mow the lawn', groupName: 'Home', assigneeId: jon.id, createdByName: 'Jon Martin' });
    const id = created.json.task.id;

    const day = (await api.get('/today')).json;
    expect(day.planned.map((t: { title: string }) => t.title)).toEqual(['Mow the lawn']);
    expect(day.load).toMatchObject({ date: today, plannedMinutes: 45, tasks: 1 });

    expect((await api.post(`/tasks/${id}/move`, { plannedDate: addDays(today, 2), timeOfDay: 'morning' })).json.task).toMatchObject({
      plannedDate: addDays(today, 2),
      timeOfDay: 'morning',
    });
    expect((await api.post(`/tasks/${id}/complete`, { done: true })).json.task.status).toBe('done');
    expect((await api.get('/today')).json.done.map((t: { title: string }) => t.title)).toEqual(['Mow the lawn']);
    expect((await api.post(`/tasks/${id}/archive`, {})).json.task.status).toBe('archived');
    expect(db.select().from(activity).all().every((a) => a.via === 'app')).toBe(true);
  });

  it('edits subtasks and links through PATCH', async () => {
    const api = as(jon);
    const { json } = await api.post('/tasks', { title: 'Taxes', subtasks: ['W-2', '1099'] });
    const id = json.task.id;
    const [w2] = json.task.subtasks;
    const updated = (await api.patch(`/tasks/${id}`, { checkSubtasks: [w2.id], addLinks: [{ url: 'https://irs.gov' }], notes: 'Due April' })).json.task;
    expect(updated).toMatchObject({ notes: 'Due April', subtasks: [{ title: 'W-2', done: true }, { title: '1099' }], links: [{ url: 'https://irs.gov/' }] });
    const trimmed = (await api.patch(`/tasks/${id}`, { removeSubtasks: [w2.id] })).json.task;
    expect(trimmed.subtasks.map((s: { title: string }) => s.title)).toEqual(['1099']);
    // Only what was sent counts as changed, so the activity feed can say what happened.
    const [latest] = (await api.get(`/tasks/${id}/activity`)).json.entries;
    expect([...latest.detail.fields].sort()).toEqual(['addLinks', 'checkSubtasks', 'notes', 'removeSubtasks']);
  });

  it('refuses groups and people that do not exist, and bad input', async () => {
    const api = as(jon);
    expect((await api.post('/tasks', { title: 'x', groupId: 'nope' })).json.error).toMatch(/No group/);
    expect((await api.post('/tasks', { title: 'x', assigneeId: 'nobody-here' })).json.error).toMatch(/No one called/);
    expect((await api.post('/tasks', { title: '' })).status).toBe(400);
    expect((await api.post('/tasks', { title: 'x', dueDate: 'next tuesday' })).status).toBe(400);
  });

  it('requires sign-in', async () => {
    const res = await app.request(`${ORIGIN}/api/tasks`);
    expect(res.status).toBe(401);
  });
});

describe('household and delegation', () => {
  it('lets an admin add someone who can then be handed tasks and sign in', async () => {
    const api = as(jon);
    expect((await api.get('/members')).json.pending).toEqual(['alex@example.com']);
    const added = await api.post('/members', { email: 'Alex@Example.com', name: 'Alex' });
    expect(added.status).toBe(201);
    const alex = added.json.member as Member;
    expect((await api.get('/members')).json).toMatchObject({ pending: [], members: [{ name: 'Jon Martin' }, { name: 'Alex', signedIn: false }] });

    const { json } = await api.post('/tasks', { title: 'Call the landlord' });
    const handed = (await api.post(`/tasks/${json.task.id}/assign`, { assigneeId: alex.id, note: 'You have the number' })).json.task;
    expect(handed).toMatchObject({ assigneeName: 'Alex', handedBackNote: 'You have the number' });

    const alexToday = (await as(alex).get('/tasks?assignee=' + alex.id)).json.tasks;
    expect(alexToday.map((t: { title: string; createdByName: string }) => [t.title, t.createdByName])).toEqual([['Call the landlord', 'Jon Martin']]);
  });

  it('only admins add or remove people, and admins stay', async () => {
    const alex = db.insert(members).values({ email: 'alex@example.com', name: 'Alex', timezone: 'America/Chicago' }).returning().get();
    expect((await as(alex).post('/members', { email: 'x@example.com', name: 'X' })).status).toBe(403);
    expect((await as(alex).patch(`/members/${alex.id}`, { name: 'Alex B' })).json.member.name).toBe('Alex B');
    expect((await as(jon).del(`/members/${jon.id}`)).status).toBe(400);
    expect((await as(jon).del(`/members/${alex.id}`)).status).toBe(204);
  });
});

describe('lists API', () => {
  it('adds and checks off items', async () => {
    const api = as(jon);
    const groceries = (await api.get('/groups')).json.groups.find((g: { kind: string }) => g.kind === 'list');
    expect((await api.post(`/lists/${groceries.id}/items`, { name: 'Eggs', quantity: '12' })).json.outcome).toBe('added');
    const { json } = await api.get(`/lists/${groceries.id}`);
    expect(json.open).toMatchObject([{ name: 'Eggs', quantity: '12' }]);
    expect((await api.post(`/lists/${groceries.id}/items/${json.open[0].id}/check`, { checked: true })).status).toBe(204);
    expect((await api.get(`/lists/${groceries.id}`)).json).toMatchObject({ open: [], checked: [{ name: 'Eggs' }] });
    expect((await api.get('/groups')).json.groups.find((g: { kind: string }) => g.kind === 'list').open).toBe(0);
  });
});

describe('phase 4 API', () => {
  it("serves a calendar range, and load follows the member's own capacity", async () => {
    const api = as(jon);
    await api.post('/tasks', { title: 'Today', plannedDate: today, estimateMinutes: 60 });
    await api.post('/tasks', { title: 'Next week', plannedDate: addDays(today, 7) });
    await api.post('/tasks', { title: 'Someday' });
    const range = (await api.get(`/tasks?status=all&who=me&from=${today}&to=${addDays(today, 6)}`)).json.tasks;
    expect(range.map((t: { title: string }) => t.title)).toEqual(['Today']);

    const dow = String(Temporal.PlainDate.from(today).dayOfWeek);
    expect((await api.patch('/me', { capacity: { [dow]: 60 }, showStreaks: false })).json.member).toMatchObject({
      capacity: { [dow]: 60 },
      showStreaks: false,
    });
    expect((await api.get(`/load?start=${today}&end=${today}`)).json.days[0]).toMatchObject({ capacityMinutes: 60, level: 'full' });
    expect((await api.patch('/me', { capacity: { 8: 60 } })).status).toBe(400);
    expect((await api.patch('/me', { capacity: null })).json.member.capacity).toBeNull();
  });

  it('edits, reorders, archives and restores groups', async () => {
    const api = as(jon);
    const groups = (await api.get('/groups')).json.groups as { id: string; name: string }[];
    const calls = groups.find((g) => g.name === 'Calls')!;
    expect((await api.patch(`/groups/${calls.id}`, { name: 'Phone', icon: 'call', color: 'blue' })).json.group).toMatchObject({ name: 'Phone', color: 'blue' });
    expect((await api.post('/groups/order', { ids: [calls.id] })).status).toBe(204);
    expect((await api.get('/groups')).json.groups[0].name).toBe('Phone');
    expect((await api.post(`/groups/${calls.id}/archive`, {})).json.group.archivedAt).not.toBeNull();
    expect((await api.get('/groups?archived=1')).json.groups.map((g: { name: string }) => g.name)).toEqual(['Phone']);
    expect((await api.post(`/groups/${calls.id}/archive`, { restore: true })).json.group.archivedAt).toBeNull();
  });

  it('shows activity, a task history, and stats', async () => {
    const api = as(jon);
    const id = (await api.post('/tasks', { title: 'Water plants' })).json.task.id;
    await api.post(`/tasks/${id}/complete`, { done: true });
    const feed = (await api.get('/activity')).json;
    expect(feed.entries.map((e: { action: string }) => e.action)).toEqual(['task.completed', 'task.created']);
    expect(feed.entries[0]).toMatchObject({ memberName: 'Jon Martin', taskTitle: 'Water plants', via: 'app' });
    expect((await api.get(`/tasks/${id}/activity`)).json.entries).toHaveLength(2);
    expect((await api.get('/activity?before=nonsense')).status).toBe(400);
    const stats = (await api.get('/stats?weeks=8&weekStart=7')).json;
    expect(stats).toMatchObject({ weekStart: 7, records: { totalDone: 1 } });
    expect(stats.weeks).toHaveLength(8);
  });
});

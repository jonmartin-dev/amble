import { beforeEach, describe, expect, it } from 'vitest';
import { createAi } from './ai/client.ts';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { createSession } from './auth/sessions.ts';
import { config, type Config } from './config.ts';
import { openDatabase, type Db } from './db/index.ts';
import { activity, members, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import { addDays, planningDate } from './lib/dates.ts';

const ORIGIN = 'https://amble.test';
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
  // No key, so nothing here calls Haiku; smart add answers with a fallback.
  ai: { ...config.ai, apiKey: '' },
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
    put: (path: string, data: unknown) => call('PUT', path, data),
    del: (path: string) => call('DELETE', path),
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  cookies.clear();
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  app = createApp({ db, config: testConfig, oidc: createOidc(testConfig), ai: createAi(testConfig) });
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

  it("changes a list's sections, and a task can be a trip for a list", async () => {
    const api = as(jon);
    const groceries = (await api.get('/groups')).json.groups.find((g: { kind: string }) => g.kind === 'list');
    await api.post(`/lists/${groceries.id}/items`, { name: 'Apples', section: 'Produce', store: 'Costco', parts: null });
    const put = await api.put(`/lists/${groceries.id}/sections`, { sections: ['Fruit', 'Frozen'], renames: [{ from: 'Produce', to: 'Fruit' }] });
    expect(put.json.group.sections).toEqual(['Fruit', 'Frozen']);
    expect((await api.get(`/lists/${groceries.id}`)).json.open).toMatchObject([{ name: 'Apples', section: 'Fruit', store: 'Costco' }]);
    const { json } = await api.post('/tasks', { title: 'Grocery run', listId: groceries.id });
    expect(json.task).toMatchObject({ listId: groceries.id, listName: 'Groceries' });
    expect((await api.get(`/lists/${groceries.id}`)).json.trip).toMatchObject({ id: json.task.id, title: 'Grocery run' });
    expect((await api.post('/tasks', { title: 'Nope', listId: 'Home' })).status).toBe(400);
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

describe('phase 5 API', () => {
  it('repeats, skips and shows what capacity Amble has learned', async () => {
    const api = as(jon);
    const { json } = await api.post('/tasks', { title: 'Bins out', repeat: { mode: 'schedule', every: 1, unit: 'day' } });
    expect(json.task).toMatchObject({ plannedDate: today, repeat: { unit: 'day' } });
    expect((await api.post(`/tasks/${json.task.id}/skip`)).json.task.plannedDate).toBe(addDays(today, 1));
    expect((await api.post('/tasks', { title: 'x', repeat: { mode: 'schedule', every: 0, unit: 'day' } })).status).toBe(400);
    const capacity = (await api.get('/capacity')).json.days;
    expect(capacity).toHaveLength(7);
    expect(capacity[0]).toMatchObject({ weekday: 1, default: 180, pinned: null, samples: 0 });
  });

  it('makes templated lists, edits items, keeps history and resets', async () => {
    const api = as(jon);
    const packing = (await api.post('/groups', { name: 'Beach trip', kind: 'list', template: 'packing' })).json.group;
    expect(packing).toMatchObject({ template: 'packing', icon: 'luggage' });
    const list = (await api.get(`/lists/${packing.id}`)).json;
    expect(list.open.map((i: { name: string }) => i.name)).toContain('Toothbrush');
    const brush = list.open.find((i: { name: string }) => i.name === 'Toothbrush');
    expect((await api.patch(`/lists/${packing.id}/items/${brush.id}`, { section: 'Toiletries', quantity: '2' })).json.item).toMatchObject({ quantity: '2' });
    await api.post(`/lists/${packing.id}/items/${brush.id}/check`, { checked: true });
    expect((await api.get(`/lists/${packing.id}/history`)).json.items.find((i: { name: string }) => i.name === 'Toothbrush')).toMatchObject({ onList: false });
    expect((await api.post(`/lists/${packing.id}/reset`)).json.reset).toBe(1);
    expect((await api.post('/groups', { name: 'Odd', kind: 'list', template: 'nope' })).status).toBe(400);
  });

  it('falls back without an AI key, and applies accepted proposals', async () => {
    const api = as(jon);
    expect((await api.get('/ai')).json).toMatchObject({ available: false, smartAdd: false, monthSpendUsd: 0 });
    expect((await api.post('/smart-add', { text: 'call mom' })).json.fallback).toMatch(/No AI model is set up/);
    const groceries = (await api.get('/groups')).json.groups.find((g: { kind: string }) => g.kind === 'list');
    const applied = await api.post('/smart-add/apply', {
      proposals: [
        {
          kind: 'task',
          task: {
            title: 'Call Mom',
            notes: null,
            groupId: null,
            assigneeId: jon.id,
            plannedDate: addDays(today, 1),
            dueDate: null,
            timeOfDay: 'evening',
            mustDo: false,
            estimateMinutes: 10,
            estimateSource: 'ai',
            subtasks: [],
            links: [],
            repeat: null,
          },
        },
        { kind: 'list_item', listId: groceries.id, name: 'Eggs', quantity: null, section: 'Dairy & eggs', note: null },
      ],
    });
    expect(applied.json).toMatchObject({ added: 1, listed: 1 });
    expect((await api.post('/smart-add/apply', { proposals: [] })).status).toBe(400);
    expect((await api.patch('/me', { smartAdd: false })).json.member.smartAdd).toBe(false);
  });
});

describe('AI settings API', () => {
  it('lets only an admin pick a model, tries it first, and never sends the key back', async () => {
    const keys: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization ?? '';
      keys.push(auth);
      if (auth !== 'Bearer sk-right-5678') return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"minutes":10}' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
    }) as unknown as typeof fetch;
    const aiConfig = { ...testConfig, oidc: { ...testConfig.oidc, clientSecret: 'client-secret' } };
    app = createApp({ db, config: aiConfig, oidc: createOidc(aiConfig), ai: createAi(aiConfig, db, fetchImpl) });
    const alex = db.insert(members).values({ email: 'alex@example.com', name: 'Alex Martin', timezone: 'America/Chicago' }).returning().get();
    const luna = { provider: 'openai', model: 'gpt-6-luna', effort: 'medium', monthlyCapUsd: 10 };

    expect((await as(alex).put('/ai', { ...luna, apiKey: 'sk-right-5678' })).status).toBe(403);
    expect((await as(jon).put('/ai', luna)).json.error).toMatch(/Add an API key from OpenAI/);
    expect((await as(jon).put('/ai', { ...luna, apiKey: 'sk-wrong' })).json).toMatchObject({ ok: false, error: '401: Incorrect API key provided' });
    expect((await as(jon).get('/ai')).json.available).toBe(false);

    expect((await as(jon).put('/ai', { ...luna, apiKey: 'sk-right-5678' })).json.ok).toBe(true);
    const shown = (await as(jon).get('/ai')).json;
    expect(shown).toMatchObject({ available: true, provider: 'openai', modelName: 'GPT-6 Luna', source: 'settings', settings: { keyEnding: '5678', prices: [0.1, 0.5] } });
    expect(JSON.stringify(shown)).not.toContain('sk-right');
    expect((await as(alex).get('/ai')).json).toMatchObject({ available: true, modelName: 'GPT-6 Luna', settings: null });
    expect((await as(alex).get('/session')).json.auth.ai).toEqual({ provider: 'openai', name: 'OpenAI' });

    // Changing only the effort keeps the saved key.
    expect((await as(jon).put('/ai', { ...luna, effort: 'low' })).json.ok).toBe(true);
    expect(keys.at(-1)).toBe('Bearer sk-right-5678');
    expect((await as(jon).put('/ai', { provider: 'custom', model: 'llama', effort: 'default', monthlyCapUsd: 10, baseUrl: 'localhost' })).json.error).toMatch(/address/);

    expect((await as(jon).del('/ai')).status).toBe(204);
    expect((await as(jon).get('/ai')).json.available).toBe(false);
  });
});

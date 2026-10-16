import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAi } from './ai/client.ts';
import { apiApp } from './test-api.ts';
import { createSession } from './auth/sessions.ts';
import { config, type Config } from './config.ts';
import { openDatabase, type Db } from './db/index.ts';
import { activity, members, pushSubscriptions, reminders, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import { parseReminderTime } from './domain/reminders.ts';
import { completeTasks, createTasks, getTask, skipTask } from './domain/tasks.ts';
import { addDays, planningDate } from './lib/dates.ts';
import { deviceName, type PushMessage } from './notify/devices.ts';
import { createLocalPush } from './notify/local-push.ts';
import { createReminderSender, reminderBody } from './notify/reminders.ts';

const ORIGIN = 'https://amble.test';
const testConfig: Config = {
  ...config,
  production: false,
  publicUrl: ORIGIN,
  basePath: '/amble',
  publicOrigin: ORIGIN,
  adminEmails: ['jon@example.com'],
  allowedEmails: ['jon@example.com', 'alex@example.com'],
  devLogin: false,
  oidc: { ...config.oidc, clientId: '', clientSecret: '' },
  ai: { ...config.ai, apiKey: '' },
};

// A device signs up as "this browser": the app shows its reminders itself.
const ENDPOINT = 'device:this-browser';
const KEYS = { p256dh: '-', auth: '-' };

let db: Db;
let app: ReturnType<typeof apiApp>;
let push: ReturnType<typeof createLocalPush>;
let jon: Member;
let alex: Member;
let today: string;
/** What the device was asked to show, and whether it could. */
let delivered: { payload: PushMessage }[];
let shows: boolean;
const cookies = new Map<string, string>();

function as(member: Member) {
  if (!cookies.has(member.id)) cookies.set(member.id, `almanac_session=${createSession(db, member.id, 'test')}`);
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}/amble/api${path}`, {
      method,
      headers: {
        cookie: cookies.get(member.id)!,
        origin: ORIGIN,
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, data: unknown = {}, headers?: Record<string, string>) => call('POST', path, data, headers),
    patch: (path: string, data: unknown, headers?: Record<string, string>) => call('PATCH', path, data, headers),
    del: (path: string) => call('DELETE', path),
  };
}

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  cookies.clear();
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  alex = db.insert(members).values({ email: 'alex@example.com', name: 'Alex Martin', timezone: 'America/Chicago' }).returning().get();
  delivered = [];
  shows = true;
  push = createLocalPush(db, async (payload) => {
    if (shows) delivered.push({ payload });
    return shows;
  });
  app = apiApp({ db, config: testConfig, ai: createAi(testConfig), push });
  today = planningDate(jon);
});

describe('setting reminders', () => {
  it("keeps each person's reminder to themselves and out of the household's activity", async () => {
    const { json } = await as(jon).post('/tasks', { title: 'Call the vet', remindAt: inMinutes(90).toISOString() });
    const id = json.task.id;
    expect(json.task.reminder).toMatchObject({ sentAt: null });
    expect(new Date(json.task.reminder.at).getTime()).toBeCloseTo(inMinutes(90).getTime(), -4);

    // Alex sees the task but not Jon's reminder, and sets her own.
    expect((await as(alex).get(`/tasks/${id}`)).json.task.reminder).toBeNull();
    await as(alex).patch(`/tasks/${id}`, { remindAt: inMinutes(30).toISOString() });
    expect(db.select().from(reminders).all()).toHaveLength(2);

    // Moving it is a reminder change only, so nothing shows in Activity.
    await as(jon).patch(`/tasks/${id}`, { remindAt: inMinutes(120).toISOString() });
    expect(db.select().from(activity).where(eq(activity.action, 'task.updated')).all()).toHaveLength(0);

    const { json: cleared } = await as(jon).patch(`/tasks/${id}`, { remindAt: null });
    expect(cleared.task.reminder).toBeNull();
    expect(db.select().from(reminders).all()).toHaveLength(1);
  });

  it('turns down a time that has passed, unless the change was made offline earlier', async () => {
    const { json } = await as(jon).post('/tasks', { title: 'Water the herbs' });
    const past = inMinutes(-30).toISOString();
    const res = await as(jon).patch(`/tasks/${json.task.id}`, { remindAt: past });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/already passed/);
    // Made an hour ago while offline: kept, and it goes out on the next run.
    const late = await as(jon).patch(`/tasks/${json.task.id}`, { remindAt: past }, { 'almanac-age': String(60 * 60_000) });
    expect(late.status).toBe(200);
    expect(late.json.task.reminder).not.toBeNull();
  });

  it('lists what is coming up, soonest first, leaving out finished tasks', async () => {
    const [a, b, c] = createTasks(db, { member: jon, via: 'app' }, [
      { title: 'Later', remindAt: inMinutes(300) },
      { title: 'Sooner', remindAt: inMinutes(20) },
      { title: 'Done already', remindAt: inMinutes(60) },
    ]);
    completeTasks(db, { member: jon, via: 'app' }, [c!.id]);
    const { json } = await as(jon).get('/reminders');
    expect(json.reminders.map((r: { title: string }) => r.title)).toEqual(['Sooner', 'Later']);
    expect(json.reminders[0].taskId).toBe(b!.id);
    expect(a).toBeTruthy();
  });

  it('reads the times Claude and smart add give in the person’s timezone', () => {
    expect(parseReminderTime('2026-10-16T18:00', 'America/Chicago').toISOString()).toBe('2026-10-16T23:00:00.000Z');
    expect(parseReminderTime('2026-10-16 18:00', 'America/Chicago').toISOString()).toBe('2026-10-16T23:00:00.000Z');
    expect(parseReminderTime('2026-10-16T18:00:00Z', 'America/Chicago').toISOString()).toBe('2026-10-16T18:00:00.000Z');
    expect(() => parseReminderTime('2026-10-16', 'America/Chicago')).toThrow(/date and a time/);
    expect(() => parseReminderTime('tomorrow at 6', 'America/Chicago')).toThrow();
  });
});

describe('devices', () => {
  it('signs a device up, names it, and moves it to whoever uses it next', async () => {
    expect((await as(jon).post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS })).status).toBe(204);
    const { json } = await as(jon).get('/push');
    expect(json.devices).toEqual([expect.objectContaining({ endpoint: ENDPOINT, device: 'Chrome on Android' })]);

    await as(alex).post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS });
    expect((await as(jon).get('/push')).json.devices).toEqual([]);
    expect((await as(alex).get('/push')).json.devices).toHaveLength(1);

    await as(alex).post('/push/unsubscribe', { endpoint: ENDPOINT });
    expect(db.select().from(pushSubscriptions).all()).toEqual([]);
  });

  it('names devices from their browser', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge on Windows');
    expect(deviceName(undefined)).toBeNull();
  });
});

describe('sending reminders', () => {
  const sender = () => createReminderSender(db, push, '/amble');
  const soon = async (title = 'Take the bins out', minutes = 1) => {
    const [task] = createTasks(db, { member: jon, via: 'app' }, [{ title, notes: 'Recycling week\nBlue bin too', remindAt: inMinutes(minutes) }]);
    return task!;
  };

  beforeEach(async () => {
    await as(jon).post('/push/subscriptions', { endpoint: ENDPOINT, keys: KEYS });
  });

  it('sends one notification when the time comes, with Done and Snooze', async () => {
    const task = await soon();
    expect(await sender().run()).toBe(0);
    expect(await sender().run(inMinutes(2))).toBe(1);
    expect(delivered).toHaveLength(1);
    const [{ payload }] = delivered as [(typeof delivered)[0]];
    expect(payload).toMatchObject({
      title: 'Take the bins out',
      body: 'Recycling week',
      url: `/amble/task/${task.id}`,
      actions: [{ action: 'done' }, { action: 'snooze' }],
      data: { kind: 'reminder', taskId: task.id, memberId: jon.id },
    });
    // Sent once only.
    expect(await sender().run(inMinutes(3))).toBe(0);
    expect(getTask(db, jon, task.id).reminder?.sentAt).toBeInstanceOf(Date);
  });

  it("skips tasks that were finished first, and moments that passed while the server was down", async () => {
    const done = await soon('Finished early');
    completeTasks(db, { member: jon, via: 'app' }, [done.id]);
    await soon('Long ago');
    expect(await sender().run(inMinutes(7 * 60))).toBe(0);
    expect(delivered).toEqual([]);
    expect(db.select({ outcome: reminders.outcome }).from(reminders).all()).toEqual([{ outcome: 'skipped' }, { outcome: 'skipped' }]);
  });

  it('says so when there is no device to show it on', async () => {
    await soon();
    db.delete(pushSubscriptions).run();
    await sender().run(inMinutes(2));
    expect(db.select({ outcome: reminders.outcome }).from(reminders).get()).toEqual({ outcome: 'no-device' });
  });

  it("tries again each minute when it can't show, then gives up", async () => {
    await soon();
    shows = false;
    await sender().run(inMinutes(2));
    expect(db.select({ sentAt: reminders.sentAt }).from(reminders).get()?.sentAt).toBeNull();
    shows = true;
    expect(await sender().run(inMinutes(3))).toBe(1);

    await soon('Another', 1);
    shows = false;
    await sender().run(inMinutes(45));
    expect(db.select({ outcome: reminders.outcome }).from(reminders).all()).toContainEqual({ outcome: 'failed' });
  });

  it('snoozes for an hour and sends again then', async () => {
    const task = await soon();
    await sender().run(inMinutes(2));
    const id = getTask(db, jon, task.id).reminder!.id;
    const { json } = await as(jon).post(`/reminders/${id}/snooze`, { minutes: 60 });
    expect(json.task.reminder.sentAt).toBeNull();
    expect(await sender().run(inMinutes(30))).toBe(0);
    expect(await sender().run(inMinutes(62))).toBe(1);
    expect(delivered).toHaveLength(2);
    // Someone else can't snooze it.
    expect((await as(alex).post(`/reminders/${id}/snooze`, { minutes: 60 })).status).toBe(400);
  });

  it('says when a deadline is close', () => {
    expect(reminderBody({ dueDate: today, notes: 'x' }, jon)).toBe('Due today');
    expect(reminderBody({ dueDate: addDays(today, 1), notes: null }, jon)).toBe('Due tomorrow');
    expect(reminderBody({ dueDate: null, notes: null }, jon)).toBeUndefined();
  });

  it('words coming reminders for when they show, for a phone that schedules them ahead', async () => {
    const tomorrow = addDays(today, 1);
    const at = Temporal.PlainDate.from(tomorrow).toZonedDateTime({ timeZone: 'America/Chicago', plainTime: '09:00' }).toInstant().toString();
    await as(jon).post('/tasks', { title: 'Renew the parking permit', dueDate: tomorrow, remindAt: at });
    const { json } = await as(jon).get('/reminders');
    expect(json.reminders).toEqual([expect.objectContaining({ title: 'Renew the parking permit', body: 'Due today' })]);
  });

  it('sends a test notification to every device', async () => {
    const { json } = await as(jon).post('/push/test');
    expect(json).toEqual({ devices: 1, sent: 1, gone: 0, failed: 0 });
    expect(delivered[0]!.payload.title).toBe('Notifications are on');
  });
});

describe('reminders on repeating tasks', () => {
  const actor = () => ({ member: jon, via: 'app' as const });
  /** 6pm local on a date, as a Date. */
  const sixPm = (date: string) => new Date(Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: jon.timezone, plainTime: '18:00' }).epochMilliseconds);

  it('carries the reminder to the next one, the same time before it', () => {
    const date = addDays(today, 2);
    const [bins] = createTasks(db, actor(), [
      { title: 'Bins out', plannedDate: date, repeat: { mode: 'schedule', every: 1, unit: 'week' }, remindAt: sixPm(addDays(date, -1)) },
    ]);
    completeTasks(db, actor(), [bins!.id]);
    const next = db.select().from(reminders).all().find((r) => r.taskId !== bins!.id)!;
    expect(next.fireAt.toISOString()).toBe(sixPm(addDays(date, 6)).toISOString());
    // Alex's view of the next one has no reminder of hers.
    expect(getTask(db, alex, next.taskId).reminder).toBeNull();
  });

  it('moves the reminder when the next one is skipped', () => {
    const date = addDays(today, 1);
    const [plants] = createTasks(db, actor(), [
      { title: 'Water plants', plannedDate: date, repeat: { mode: 'schedule', every: 1, unit: 'week' }, remindAt: sixPm(date) },
    ]);
    skipTask(db, actor(), plants!.id);
    expect(getTask(db, jon, plants!.id).reminder?.at.toISOString()).toBe(sixPm(addDays(date, 7)).toISOString());
  });
});

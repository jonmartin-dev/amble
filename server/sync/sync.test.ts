import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.ts';
import { groups, listItems, members, reminders, subtasks, tasks, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import type { Actor } from '../domain/household.ts';
import { addListItems } from '../domain/lists.ts';
import { setReminder } from '../domain/reminders.ts';
import { completeTasks, createTasks, getTask, updateTask } from '../domain/tasks.ts';
import { startCapture, stamp } from './capture.ts';
import { Clock } from './hlc.ts';
import { exportState, mergeState, missingMine, type SyncState } from './state.ts';
import { SYNCED } from './tables.ts';

const SCHEMA = '0010_sync';

/** A device: its own database and clock, with a fake wall clock tests can move. */
function device(name: string, from?: { state(): SyncState }) {
  const db = openDatabase(':memory:');
  let wall = 1_800_000_000_000;
  const clock = new Clock(name.padEnd(8, '0').slice(0, 8), () => wall);
  startCapture(db);
  const d = {
    db,
    clock,
    /** Time passes. What was changed so far gets its time first, as the app does after each request. */
    later(ms = 1000) {
      stamp(db, clock);
      wall += ms;
    },
    state: () => exportState(db, clock, SCHEMA),
    take: (s: SyncState) => mergeState(db, clock, s, SCHEMA),
    member: undefined as unknown as Member,
    actor: () => ({ member: d.member, via: 'app' }) as Actor,
  };
  if (from) {
    d.take(from.state());
    d.member = db.select().from(members).get()!;
  }
  return d;
}
type Device = ReturnType<typeof device>;

/** Everything that syncs, as plain values, to compare copies. */
function contents(db: Db) {
  const out: Record<string, unknown[]> = {};
  for (const t of SYNCED) {
    const local = new Set(t.local ?? []);
    const rows = db.all(sql.raw(`SELECT * FROM "${t.name}" ORDER BY ${t.pk.map((c) => `"${c}"`).join(', ')}`)) as Record<string, unknown>[];
    out[t.name] = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !local.has(k))));
  }
  return out;
}

/** Each sends to the other until neither has anything new: what a few rounds of sync do. */
function exchange(...devices: Device[]) {
  for (let round = 0; round < 3; round++) for (const a of devices) for (const b of devices) if (a !== b) b.take(a.state());
}

function household() {
  const a = device('aaaa');
  a.member = a.db.insert(members).values({ email: 'sam@example.com', name: 'Sam', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  seedStarterGroups(a.db);
  const b = device('bbbb', a);
  return { a, b };
}

const groupNamed = (d: Device, name: string) => d.db.select().from(groups).where(eq(groups.name, name)).get()!;

describe('sync', () => {
  it('copies a household to a new device and keeps them in step', () => {
    const { a, b } = household();
    expect(contents(b.db)).toEqual(contents(a.db));
    const [task] = createTasks(a.db, a.actor(), [{ title: 'Mow the lawn', groupId: groupNamed(a, 'Home').id, estimateMinutes: 45 }]);
    b.take(a.state());
    expect(getTask(b.db, b.member, task!.id)).toMatchObject({ title: 'Mow the lawn', groupName: 'Home', estimateMinutes: 45 });
    expect(contents(b.db)).toEqual(contents(a.db));
  });

  it('keeps both of two changes to different fields, and the later of two to the same one', () => {
    const { a, b } = household();
    const [task] = createTasks(a.db, a.actor(), [{ title: 'Call the plumber' }]);
    b.take(a.state());
    // Offline, each changes something.
    updateTask(a.db, a.actor(), task!.id, { notes: 'The kitchen sink' });
    a.later();
    updateTask(b.db, b.actor(), task!.id, { estimateMinutes: 15 });
    b.later(5000);
    updateTask(a.db, a.actor(), task!.id, { title: 'Call the plumber (A)' });
    a.later(10_000);
    updateTask(b.db, b.actor(), task!.id, { title: 'Call the plumber (B, later)' });
    exchange(a, b);
    for (const d of [a, b]) {
      expect(getTask(d.db, d.member, task!.id)).toMatchObject({ title: 'Call the plumber (B, later)', notes: 'The kitchen sink', estimateMinutes: 15 });
    }
    expect(contents(b.db)).toEqual(contents(a.db));
  });

  it('ends up the same whatever order three devices hear from each other in', () => {
    const { a, b } = household();
    const c = device('cccc', a);
    const [t] = createTasks(a.db, a.actor(), [{ title: 'Paint the fence' }]);
    b.take(a.state());
    c.take(a.state());
    updateTask(a.db, a.actor(), t!.id, { title: 'Paint the fence white' });
    b.later(300);
    updateTask(b.db, b.actor(), t!.id, { title: 'Paint the fence green', mustDo: true });
    c.later(700);
    updateTask(c.db, c.actor(), t!.id, { notes: 'Two coats', addSubtasks: ['Buy paint'] });
    createTasks(c.db, c.actor(), [{ title: 'Return the ladder' }]);
    // C hears from B before A; A hears only from C at first.
    c.take(b.state());
    a.take(c.state());
    b.take(a.state());
    exchange(a, b, c);
    expect(contents(b.db)).toEqual(contents(a.db));
    expect(contents(c.db)).toEqual(contents(a.db));
    expect(getTask(a.db, a.member, t!.id)).toMatchObject({ title: 'Paint the fence green', mustDo: true, notes: 'Two coats' });
  });

  it('carries removals, and a removal loses to a later change', () => {
    const { a, b } = household();
    const [t] = createTasks(a.db, a.actor(), [{ title: 'Pack for the trip', subtasks: ['Socks', 'Charger'] }]);
    b.take(a.state());
    const [socks, charger] = getTask(a.db, a.member, t!.id).subtasks;
    a.later();
    updateTask(a.db, a.actor(), t!.id, { removeSubtasks: [socks!.id] });
    b.later(5000);
    // B, later and unaware, checks off the charger and renames the task.
    updateTask(b.db, b.actor(), t!.id, { checkSubtasks: [charger!.id], title: 'Pack!' });
    exchange(a, b);
    for (const d of [a, b]) {
      expect(getTask(d.db, d.member, t!.id).subtasks.map((s) => [s.title, s.done])).toEqual([['Charger', true]]);
    }
    expect(contents(b.db)).toEqual(contents(a.db));
  });

  it('clears or removes what pointed at a row another device removed', () => {
    const { a, b } = household();
    const [t] = createTasks(a.db, a.actor(), [{ title: 'Fix the gate' }]);
    b.take(a.state());
    // A removes the task outright; B, earlier and offline, gave it a step.
    b.later(100);
    updateTask(b.db, b.actor(), t!.id, { addSubtasks: ['Buy hinges'] });
    a.later(60_000);
    a.db.delete(tasks).where(eq(tasks.id, t!.id)).run();
    exchange(a, b);
    for (const d of [a, b]) {
      expect(d.db.select().from(tasks).where(eq(tasks.id, t!.id)).get()).toBeUndefined();
      expect(d.db.select().from(subtasks).all()).toEqual([]);
    }
    expect(contents(b.db)).toEqual(contents(a.db));
  });

  it('makes one next task when two devices finish a repeating task offline', () => {
    const { a, b } = household();
    const today = '2026-10-15';
    const [t] = createTasks(a.db, a.actor(), [{ title: 'Take out the bins', plannedDate: today, repeat: { mode: 'schedule', every: 1, unit: 'week' }, subtasks: ['Recycling'] }]);
    b.take(a.state());
    completeTasks(a.db, a.actor(), [t!.id]);
    b.later(2000);
    completeTasks(b.db, b.actor(), [t!.id]);
    exchange(a, b);
    for (const d of [a, b]) {
      const open = d.db.select().from(tasks).where(eq(tasks.status, 'open')).all();
      expect(open.map((x) => x.title)).toEqual(['Take out the bins']);
      expect(d.db.select().from(subtasks).where(eq(subtasks.taskId, open[0]!.id)).all()).toHaveLength(1);
    }
    expect(contents(b.db)).toEqual(contents(a.db));
  });

  it('puts milk on the list once when two people add it offline', () => {
    const { a, b } = household();
    const grocery = groupNamed(a, 'Groceries');
    addListItems(a.db, a.actor(), grocery, [{ name: 'Milk' }]);
    b.later(500);
    addListItems(b.db, b.actor(), groupNamed(b, 'Groceries'), [{ name: 'milk ' }, { name: 'Eggs' }]);
    exchange(a, b);
    for (const d of [a, b]) {
      expect(
        d.db
          .select()
          .from(listItems)
          .all()
          .map((i) => i.name.trim().toLowerCase())
          .sort(),
      ).toEqual(['eggs', 'milk']);
    }
    expect(contents(b.db)).toEqual(contents(a.db));
  });

  it('keeps one reminder per person per task, and a moved one goes out again on every device', () => {
    const { a, b } = household();
    const [t] = createTasks(a.db, a.actor(), [{ title: 'Call Mom' }]);
    b.take(a.state());
    const soon = new Date(Date.now() + 3_600_000);
    setReminder(a.db, a.member, t!.id, soon);
    setReminder(b.db, b.member, t!.id, new Date(soon.getTime() + 60_000));
    exchange(a, b);
    expect(a.db.select().from(reminders).all()).toHaveLength(1);
    expect(contents(b.db)).toEqual(contents(a.db));
    // B showed it; then A moves it. B shows it again at the new time.
    b.db.update(reminders).set({ sentAt: new Date(), outcome: 'sent' }).run();
    a.later(120_000);
    setReminder(a.db, a.member, t!.id, new Date(soon.getTime() + 7_200_000));
    b.take(a.state());
    expect(b.db.select().from(reminders).get()).toMatchObject({ sentAt: null, outcome: null });
  });

  it('knows when a copy is missing its own changes, so a write someone else overwrote is sent again', () => {
    const { a, b } = household();
    // The shared copy as A last wrote it.
    let shared = a.state();
    createTasks(a.db, a.actor(), [{ title: 'From A' }]);
    expect(missingMine(a.db, a.clock, shared)).toBe(true);
    shared = a.state();
    expect(missingMine(a.db, a.clock, shared)).toBe(false);
    // B, working from an older copy, writes over A's.
    createTasks(b.db, b.actor(), [{ title: 'From B' }]);
    shared = b.state();
    a.take(shared);
    expect(missingMine(a.db, a.clock, shared)).toBe(true);
    shared = a.state();
    b.take(shared);
    expect(b.db.select({ title: tasks.title }).from(tasks).all().map((t) => t.title).sort()).toEqual(['From A', 'From B']);
  });

  it('takes rows from before sync was on as older than any change since', () => {
    const a = device('aaaa');
    // A server that ran for a while before syncing: its rows have no times.
    const server = openDatabase(':memory:');
    const jon = server.insert(members).values({ email: 'jon@example.com', name: 'Jon', timezone: 'America/Chicago', role: 'admin' }).returning().get();
    seedStarterGroups(server);
    createTasks(server, { member: jon, via: 'app' }, [{ title: 'Old task' }]);
    const serverClock = new Clock('server00', () => 1_800_000_000_000);
    startCapture(server);
    a.take(exportState(server, serverClock, SCHEMA));
    a.member = a.db.select().from(members).get()!;
    const old = a.db.select().from(tasks).get()!;
    updateTask(a.db, a.actor(), old.id, { title: 'Old task, renamed' });
    mergeState(server, serverClock, a.state(), SCHEMA);
    expect(server.select().from(tasks).get()?.title).toBe('Old task, renamed');
    expect(stamp(server, serverClock)).toBe(0);
  });
});

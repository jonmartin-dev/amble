import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.ts';
import { activity, groups, members, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { addDays, planningDate, planningDayStart } from '../lib/dates.ts';
import { createGroup, resolveGroup, resolveMember, type Actor } from './household.ts';
import { addListItems, checkListItems, getListItems } from './lists.ts';
import { findGap, getLoad } from './load.ts';
import {
  archiveTasks,
  assignTask,
  completeTasks,
  createTasks,
  getTask,
  getToday,
  listTasks,
  moveTasks,
  updateTask,
} from './tasks.ts';

let db: Db;
let jon: Member;
let alex: Member;
let asJon: Actor;
let today: string;

function member(email: string, name: string) {
  return db
    .insert(members)
    .values({ email, name, timezone: 'America/Chicago', role: 'member' })
    .returning()
    .get();
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  jon = member('jon@example.com', 'Jon Martin');
  alex = member('alex@example.com', 'Alex B');
  asJon = { member: jon, via: 'claude' };
  today = planningDate(jon);
});

describe('dates', () => {
  it('keeps the small hours on the previous planning day', () => {
    const clock = { timezone: 'America/Chicago', dayCutoffHour: 4 };
    // 3:30am and 4:30am Chicago time on Oct 14 (UTC-5 in October).
    expect(planningDate(clock, Temporal.Instant.from('2026-10-14T08:30:00Z'))).toBe('2026-10-13');
    expect(planningDate(clock, Temporal.Instant.from('2026-10-14T09:30:00Z'))).toBe('2026-10-14');
    expect(planningDayStart(clock, '2026-10-14').toISOString()).toBe('2026-10-14T09:00:00.000Z');
  });
});

describe('household', () => {
  it('resolves people by first name, email and "me", and "anyone" to shared', () => {
    expect(resolveMember(db, jon, 'alex')?.id).toBe(alex.id);
    expect(resolveMember(db, jon, 'ALEX@example.com')?.id).toBe(alex.id);
    expect(resolveMember(db, jon, 'me')?.id).toBe(jon.id);
    expect(resolveMember(db, jon, 'anyone')).toBeNull();
    expect(() => resolveMember(db, jon, 'bob')).toThrow(/Members: Jon Martin, Alex B/);
  });

  it('resolves groups by name or unique prefix and lists the options when it can\'t', () => {
    expect(resolveGroup(db, jon, 'home').name).toBe('Home');
    expect(resolveGroup(db, jon, 'proj').name).toBe('Projects');
    expect(resolveGroup(db, jon, 'groceries', 'list').name).toBe('Groceries');
    expect(() => resolveGroup(db, jon, 'Garden')).toThrow(/Available: Home, Errands, Groceries/);
  });

  it("hides a member's private group and its tasks from everyone else", () => {
    const secret = createGroup(db, asJon, { name: 'Gifts', private: true });
    createTasks(db, asJon, [{ title: 'Buy Alex a present', groupId: secret.id }]);
    expect(listTasks(db, jon, {})).toHaveLength(1);
    expect(listTasks(db, alex, {})).toHaveLength(0);
    expect(() => resolveGroup(db, alex, 'Gifts')).toThrow();
  });
});

describe('tasks', () => {
  it('creates tasks for the actor by default, with subtasks and links, and logs them via Claude', () => {
    const home = resolveGroup(db, jon, 'Home');
    const [task] = createTasks(db, asJon, [
      {
        title: '  Clean gutters ',
        groupId: home.id,
        mustDo: true,
        subtasks: ['Get ladder', 'Bag leaves'],
        links: [{ url: 'https://example.com/gutters' }],
      },
    ]);
    expect(task).toMatchObject({ title: 'Clean gutters', assigneeId: jon.id, groupName: 'Home', mustDo: true });
    expect(task!.subtasks.map((s) => s.title)).toEqual(['Get ladder', 'Bag leaves']);
    expect(task!.links[0]!.url).toBe('https://example.com/gutters');
    expect(db.select().from(activity).all()).toMatchObject([{ action: 'task.created', via: 'claude', memberId: jon.id }]);
  });

  it('builds the day list from planned, carried-over and due tasks', () => {
    createTasks(db, asJon, [
      { title: 'Planned today', plannedDate: today },
      { title: 'Left from yesterday', plannedDate: addDays(today, -1) },
      { title: 'Due today, unplanned', dueDate: today },
      { title: 'Due today, planned next week', dueDate: today, plannedDate: addDays(today, 7) },
      { title: 'Alex only', plannedDate: today, assigneeId: alex.id },
      { title: 'Shared', plannedDate: today, assigneeId: null },
      { title: 'Someday' },
    ]);
    const mine = getToday(db, jon);
    expect(mine.planned.map((t) => t.title).sort()).toEqual(['Planned today', 'Shared']);
    expect(mine.carriedOver.map((t) => t.title)).toEqual(['Left from yesterday']);
    expect(mine.due.map((t) => t.title).sort()).toEqual(['Due today, planned next week', 'Due today, unplanned']);
    expect(getToday(db, jon, 'everyone').planned).toHaveLength(3);
    expect(getToday(db, jon, alex).planned.map((t) => t.title).sort()).toEqual(['Alex only', 'Shared']);
  });

  it('finds tasks by short id prefix and by every word of a search', () => {
    const [task] = createTasks(db, asJon, [{ title: 'Call the dentist', notes: 'Ask about the cleaning' }]);
    expect(getTask(db, jon, task!.id.slice(0, 8)).title).toBe('Call the dentist');
    expect(listTasks(db, jon, { query: 'dentist cleaning' })).toHaveLength(1);
    expect(listTasks(db, jon, { query: 'dentist plumber' })).toHaveLength(0);
    expect(() => getTask(db, jon, 'abc')).toThrow(/isn't a task id/);
  });

  it('updates fields and ticks subtasks by title', () => {
    const [task] = createTasks(db, asJon, [{ title: 'Taxes', subtasks: ['W-2', '1099'] }]);
    const updated = updateTask(db, asJon, task!.id, {
      dueDate: addDays(today, 3),
      estimateMinutes: 90,
      checkSubtasks: ['w-2'],
      addLinks: [{ url: 'https://irs.gov' }],
    });
    expect(updated).toMatchObject({ dueDate: addDays(today, 3), estimateMinutes: 90, estimateSource: 'user' });
    expect(updated.subtasks).toMatchObject([{ title: 'W-2', done: true }, { title: '1099', done: false }]);
    expect(updateTask(db, asJon, task!.id, { removeLinks: ['https://irs.gov'] }).links).toHaveLength(0);
  });

  it('completes, reopens, moves, hands off and archives', () => {
    const [a, b] = createTasks(db, asJon, [{ title: 'A' }, { title: 'B' }]);
    expect(completeTasks(db, asJon, [a!.id])[0]).toMatchObject({ status: 'done', completedById: jon.id });
    expect(getToday(db, jon).done.map((t) => t.title)).toEqual(['A']);
    expect(completeTasks(db, asJon, [a!.id], false)[0]).toMatchObject({ status: 'open', completedAt: null });

    expect(moveTasks(db, asJon, [b!.id], addDays(today, 1))[0]!.plannedDate).toBe(addDays(today, 1));
    expect(moveTasks(db, asJon, [b!.id], null)[0]!.plannedDate).toBeNull();

    const handed = assignTask(db, asJon, b!.id, alex.id, 'You know the landlord');
    expect(handed).toMatchObject({ assigneeId: alex.id, assigneeName: 'Alex B', handedBackNote: 'You know the landlord' });

    expect(archiveTasks(db, asJon, [b!.id])[0]!.status).toBe('archived');
    expect(listTasks(db, jon, { status: 'all' }).map((t) => t.title)).toEqual(['A']);
    expect(archiveTasks(db, asJon, [b!.id], true)[0]!.status).toBe('open');
  });

  it('rejects bad links before saving anything', () => {
    expect(() => createTasks(db, asJon, [{ title: 'x', links: [{ url: 'javascript:alert(1)' }] }])).toThrow(/http or https/);
    expect(listTasks(db, jon, {})).toHaveLength(0);
  });
});

describe('lists', () => {
  it('adds without duplicates, brings back bought items, and checks off by name', () => {
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    const first = addListItems(db, asJon, groceries, [{ name: 'Milk' }, { name: 'Eggs', quantity: '12' }]);
    expect(first.map((r) => r.outcome)).toEqual(['added', 'added']);
    expect(addListItems(db, asJon, groceries, [{ name: 'milk', quantity: '2' }])[0]).toMatchObject({
      outcome: 'already on the list',
      item: { name: 'Milk', quantity: '2' },
    });
    expect(checkListItems(db, asJon, groceries, ['MILK'])).toEqual(['Milk']);
    expect(getListItems(db, groceries).open.map((i) => i.name)).toEqual(['Eggs']);
    expect(getListItems(db, groceries, true).checked.map((i) => i.name)).toEqual(['Milk']);
    expect(addListItems(db, asJon, groceries, [{ name: 'Milk' }])[0]!.outcome).toBe('back on the list');
  });

  it('refuses to add items to a task group', () => {
    const home = db.select().from(groups).all().find((g) => g.name === 'Home')!;
    expect(() => addListItems(db, asJon, home, [{ name: 'x' }])).toThrow(/task group/);
  });
});

describe('load', () => {
  it('counts planned minutes against capacity, guessing 30 for unestimated tasks', () => {
    createTasks(db, asJon, [
      { title: 'Big', plannedDate: today, estimateMinutes: 120 },
      { title: 'Unknown', plannedDate: today },
      { title: 'Alex', plannedDate: today, assigneeId: alex.id, estimateMinutes: 60 },
    ]);
    const [day] = getLoad(db, jon, jon, today, today);
    expect(day).toMatchObject({ tasks: 2, plannedMinutes: 150, guessed: 1 });
    expect(['moderate', 'full']).toContain(day!.level);
  });

  it('suggests the lightest day before the due date, preferring earlier on ties', () => {
    createTasks(db, asJon, [
      { title: 'Busy today', plannedDate: today, estimateMinutes: 170 },
      { title: 'Busy tomorrow', plannedDate: addDays(today, 1), estimateMinutes: 200 },
      { title: 'A little on day 3', plannedDate: addDays(today, 3), estimateMinutes: 30 },
    ]);
    const gap = findGap(db, jon, jon, addDays(today, 3), 60);
    expect(gap.date).toBe(addDays(today, 2));
    expect(gap.fits).toBe(true);
    expect(() => findGap(db, jon, jon, addDays(today, -1))).toThrow(/already passed/);
  });
});

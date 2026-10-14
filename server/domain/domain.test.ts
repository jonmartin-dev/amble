import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.ts';
import { activity, groups, members, tasks, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { addDays, planningDate, planningDayStart } from '../lib/dates.ts';
import { listActivity } from './activity.ts';
import {
  archivedGroups,
  archiveGroup,
  createGroup,
  reorderGroups,
  resolveGroup,
  resolveMember,
  updateGroup,
  type Actor,
} from './household.ts';
import { addListItems, checkListItems, getListItems, openTrip, planTrip, setListSections } from './lists.ts';
import { capacityFor, findGap, getLoad } from './load.ts';
import { getStats } from './stats.ts';
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

  it("guesses a new item's aisle unless someone said, and one bought before keeps its own", () => {
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    addListItems(db, asJon, groceries, [{ name: 'Oat milk', section: 'Pantry' }]);
    checkListItems(db, asJon, groceries, ['Oat milk']);
    const added = addListItems(db, asJon, groceries, [
      { name: 'Peanut butter' },
      { name: 'Lemons' },
      { name: 'Chicken broth' },
      { name: 'Widgets' },
      { name: 'Eggs', section: null },
      { name: 'oat milk' },
    ]);
    expect(added.map((r) => r.item.section)).toEqual(['Pantry', 'Produce', 'Pantry', null, null, 'Pantry']);
  });

  it('fills a new list from a kit, and gift ideas start private', () => {
    const packing = createGroup(db, asJon, { name: 'Beach trip', kind: 'list', template: 'packing', kit: 'Beach' });
    expect(getListItems(db, packing).open.map((i) => i.name)).toContain('Sunscreen');
    const empty = createGroup(db, asJon, { name: 'Ski trip', kind: 'list', template: 'packing', kit: null });
    expect(getListItems(db, empty).open).toEqual([]);
    expect(() => createGroup(db, asJon, { name: 'Moon trip', kind: 'list', template: 'packing', kit: 'Moon' })).toThrow(/no "Moon" kit/);
    const gifts = createGroup(db, asJon, { name: 'Gift ideas', kind: 'list', template: 'gifts' });
    expect(gifts.privateTo).toBe(jon.id);
    expect(createGroup(db, asJon, { name: 'Shared gifts', kind: 'list', template: 'gifts', private: false }).privateTo).toBeNull();
  });

  it('renames, reorders and removes sections, taking items along', () => {
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    addListItems(db, asJon, groceries, [
      { name: 'Apples', section: 'Produce' },
      { name: 'Ice cream', section: 'Frozen' },
      { name: 'Rice', section: 'Pantry' },
    ]);
    const updated = setListSections(db, asJon, groceries, ['Frozen', 'Fruit & veg', 'Pantry', 'pantry'], [{ from: 'Produce', to: 'Fruit & veg' }]);
    expect(updated.sections).toEqual(['Frozen', 'Fruit & veg', 'pantry']);
    const items = getListItems(db, updated).open;
    expect(Object.fromEntries(items.map((i) => [i.name, i.section]))).toEqual({ Apples: 'Fruit & veg', 'Ice cream': 'Frozen', Rice: 'Pantry' });
    setListSections(db, asJon, updated, ['Frozen']);
    expect(getListItems(db, updated).open.find((i) => i.name === 'Apples')!.section).toBeNull();
  });

  it("plans a list's trip as one task, and moves it rather than making a second", () => {
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    const first = planTrip(db, asJon, groceries, addDays(today, 2));
    expect(first).toMatchObject({ created: true, task: { title: 'Grocery run', listId: groceries.id, listName: 'Groceries', groupName: 'Errands', estimateMinutes: 45 } });
    const second = planTrip(db, asJon, groceries, addDays(today, 3));
    expect(second).toMatchObject({ created: false, task: { id: first.task.id, plannedDate: addDays(today, 3) } });
    expect(openTrip(db, groceries)?.id).toBe(first.task.id);
    const costco = createGroup(db, asJon, { name: 'Costco', kind: 'list', template: 'groceries' });
    expect(planTrip(db, asJon, costco, null).task.title).toBe('Costco run');
    const packing = createGroup(db, asJon, { name: 'Packing', kind: 'list', template: 'packing' });
    expect(() => planTrip(db, asJon, packing, null)).toThrow(/plans as a trip/);
  });

  it("keeps someone else's private list name off a trip task the household can see", () => {
    const secret = createGroup(db, asJon, { name: 'Surprise party', kind: 'list', template: 'shopping', private: true });
    const [task] = createTasks(db, asJon, [{ title: 'Party supplies run', listId: secret.id }]);
    expect(getTask(db, jon, task!.id).listName).toBe('Surprise party');
    expect(getTask(db, alex, task!.id).listName).toBeNull();
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

describe('capacity', () => {
  it("uses each member's own capacity per weekday, where a day off has no room at all", () => {
    const dow = (date: string) => String(Temporal.PlainDate.from(date).dayOfWeek);
    const tomorrow = addDays(today, 1);
    const custom = db
      .update(members)
      .set({ capacity: { [dow(today)]: 60, [dow(tomorrow)]: 0 } })
      .where(eq(members.id, jon.id))
      .returning()
      .get();
    createTasks(db, asJon, [{ title: 'An hour', plannedDate: today, estimateMinutes: 60 }]);
    const [d0, d1, d2] = getLoad(db, custom, custom, today, addDays(today, 2));
    expect(d0).toMatchObject({ capacityMinutes: 60, level: 'full' });
    expect(d1).toMatchObject({ capacityMinutes: 0, level: 'light' });
    expect(d2!.capacityMinutes).toBe(capacityFor(addDays(today, 2)));
    // Neither day fits another half hour, and the day off is never the better choice.
    expect(findGap(db, custom, custom, tomorrow, 30)).toMatchObject({ date: today, fits: false });
  });
});

describe('groups', () => {
  it('renames, recolors and reorders, refusing a name that is taken', () => {
    const home = resolveGroup(db, jon, 'Home');
    expect(updateGroup(db, asJon, home.id, { name: 'House', color: 'rose' })).toMatchObject({ name: 'House', color: 'rose' });
    expect(() => updateGroup(db, asJon, 'House', { name: 'errands' })).toThrow(/already a group called Errands/);
    const order = reorderGroups(db, jon, [resolveGroup(db, jon, 'Calls').id]).map((g) => g.name);
    expect(order[0]).toBe('Calls');
    expect(order).toContain('House');
    expect(() => reorderGroups(db, jon, ['nope'])).toThrow(/No group/);
  });

  it('archives a group, moving its open tasks out, and restores the ones nobody regrouped', () => {
    const calls = resolveGroup(db, jon, 'Calls');
    const home = resolveGroup(db, jon, 'Home');
    const [mom, dentist, bank] = createTasks(db, asJon, [
      { title: 'Call mom', groupId: calls.id },
      { title: 'Call the dentist', groupId: calls.id },
      { title: 'Call the bank', groupId: calls.id },
    ]);
    completeTasks(db, asJon, [bank!.id]);
    archiveGroup(db, asJon, calls.id);
    expect(() => resolveGroup(db, jon, 'Calls')).toThrow(/No group/);
    expect(getTask(db, jon, mom!.id).groupId).toBeNull();
    // Finished tasks keep their group, so stats still know where they came from.
    expect(getTask(db, jon, bank!.id).groupId).toBe(calls.id);
    updateTask(db, asJon, dentist!.id, { groupId: home.id });
    expect(archivedGroups(db, jon.id).map((g) => g.name)).toEqual(['Calls']);

    archiveGroup(db, asJon, calls.id, true);
    expect(getTask(db, jon, mom!.id).groupId).toBe(calls.id);
    expect(getTask(db, jon, dentist!.id).groupId).toBe(home.id);
    expect(archivedGroups(db, jon.id)).toEqual([]);
  });
});

describe('activity', () => {
  it('folds repeated edits and hides private groups from everyone else', () => {
    const asAlex: Actor = { member: alex, via: 'app' };
    const [task] = createTasks(db, asJon, [{ title: 'Paint the fence' }]);
    updateTask(db, asJon, task!.id, { notes: 'White' });
    updateTask(db, asJon, task!.id, { dueDate: addDays(today, 3) });
    completeTasks(db, asAlex, [task!.id]);
    const secret = createGroup(db, asAlex, { name: 'Surprise', private: true });
    createTasks(db, asAlex, [{ title: 'Buy a gift', groupId: secret.id }]);

    const { entries, next } = listActivity(db, jon);
    expect(entries.map((e) => e.action)).toEqual(['task.completed', 'task.updated', 'task.created']);
    expect(entries[0]).toMatchObject({ memberName: 'Alex B', taskTitle: 'Paint the fence', via: 'app' });
    expect(entries[1]).toMatchObject({ count: 2, via: 'claude', detail: { fields: ['dueDate', 'notes'] } });
    expect(next).toBeNull();
    expect(listActivity(db, alex).entries.map((e) => e.action)).toEqual([
      'task.created',
      'group.created',
      'task.completed',
      'task.updated',
      'task.created',
    ]);
    expect(listActivity(db, jon, { taskId: task!.id }).entries).toHaveLength(3);
  });

  it('folds items added to one list back to back into one entry', () => {
    const groceries = resolveGroup(db, jon, 'Groceries', 'list');
    addListItems(db, asJon, groceries, [{ name: 'Milk' }, { name: 'Eggs' }, { name: 'Bread' }]);
    checkListItems(db, asJon, groceries, ['Milk']);
    const { entries } = listActivity(db, jon);
    expect(entries.map((e) => [e.action, e.count])).toEqual([
      ['list.items_checked', 1],
      ['list.item_added', 3],
    ]);
    expect(entries[1]!.detail).toMatchObject({ list: 'Groceries', items: ['Milk', 'Eggs', 'Bread'] });
  });

  it('pages through the feed without skipping or repeating anything', () => {
    createTasks(db, asJon, Array.from({ length: 7 }, (_, i) => ({ title: `Task ${i}` })));
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = listActivity(db, jon, { limit: 3, before });
      seen.push(...page.entries.map((e) => e.taskTitle!));
      before = page.next ?? undefined;
    } while (before);
    expect(seen).toEqual(['Task 6', 'Task 5', 'Task 4', 'Task 3', 'Task 2', 'Task 1', 'Task 0']);
  });
});

describe('stats', () => {
  it('counts what gets done per week and person, and keeps records only for those who want them', () => {
    const asAlex: Actor = { member: alex, via: 'app' };
    const home = resolveGroup(db, jon, 'Home').id;
    const [old, todays, alexs] = createTasks(db, asJon, [
      { title: 'Old one', plannedDate: addDays(today, -1) },
      { title: 'Today', plannedDate: today },
      { title: 'For Alex', assigneeId: alex.id },
      { title: 'Left open', plannedDate: addDays(today, -2) },
      { title: 'Fix the gate', groupId: home },
      { title: 'Clean the gutters', groupId: home },
    ]);
    db.update(tasks).set({ createdAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(tasks.id, old!.id)).run();
    completeTasks(db, asJon, [old!.id, todays!.id]);
    completeTasks(db, asAlex, [alexs!.id]);

    const stats = getStats(db, jon, { weeks: 4, weekStart: 1 });
    expect(stats.weeks).toHaveLength(4);
    expect(stats.weeks.at(-1)).toMatchObject({ total: 3, byMember: { [jon.id]: 2, [alex.id]: 1 } });
    expect(stats.weekdays.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(stats.weekdays.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(stats.timesOfDay.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(stats.pilingUp[0]).toMatchObject({ name: 'Home', open: 2, added: 2, done: 0 });
    // Two days ago was left unfinished, so the streak is yesterday and today.
    expect(stats.records).toMatchObject({ streak: { current: 2, best: 2 }, totalDone: 2, oldestDone: { title: 'Old one' } });

    const quiet = db.update(members).set({ showStreaks: false }).where(eq(members.id, alex.id)).returning().get();
    expect(getStats(db, quiet).records).toBeNull();
    expect(getStats(db, jon, { weekStart: 7 }).weekdays[0]!.day).toBe(7);
  });
});

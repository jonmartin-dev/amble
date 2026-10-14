import { beforeEach, describe, expect, it } from 'vitest';
import { describeMonths, describeRepeat, type Repeat } from '../../shared/repeat.ts';
import { openDatabase, type Db } from '../db/index.ts';
import { members, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import type { Actor } from './household.ts';
import { anchorRule, cleanRepeat, firstOccurrence, matches, nextDate } from './repeat.ts';
import { archiveTasks, completeTasks, createTasks, getTask, listTasks, skipTask, updateTask } from './tasks.ts';

const weekly = (weekdays: number[], every = 1): Repeat => ({ mode: 'schedule', every, unit: 'week', weekdays });

describe('repeat dates', () => {
  // 2026-10-13 is a Tuesday.
  it('finds weekly and every-other-week days', () => {
    expect(firstOccurrence(weekly([7]), '2026-10-13', '2026-10-13')).toBe('2026-10-18');
    expect(firstOccurrence(weekly([2]), '2026-10-13', '2026-10-13')).toBe('2026-10-13');
    const biweekly = weekly([2, 5], 2);
    expect(['2026-10-13', '2026-10-16', '2026-10-20', '2026-10-27', '2026-10-30'].map((d) => matches(biweekly, '2026-10-13', d))).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('handles month ends, nth weekdays and years', () => {
    const on31: Repeat = { mode: 'schedule', every: 1, unit: 'month', day: 31 };
    expect(nextDate(on31, '2026-01-31', '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    const last: Repeat = { mode: 'schedule', every: 1, unit: 'month', day: -1 };
    expect(nextDate(last, '2026-10-31', '2026-10-31', '2026-10-31')).toBe('2026-11-30');
    const secondThursday: Repeat = { mode: 'schedule', every: 1, unit: 'month', nth: 2, weekday: 4 };
    expect(firstOccurrence(secondThursday, '2026-10-13', '2026-10-13')).toBe('2026-11-12');
    const lastFriday: Repeat = { mode: 'schedule', every: 1, unit: 'month', nth: -1, weekday: 5 };
    expect(firstOccurrence(lastFriday, '2026-10-13', '2026-10-13')).toBe('2026-10-30');
    const quarterly: Repeat = { mode: 'schedule', every: 3, unit: 'month', day: 1 };
    expect(nextDate(quarterly, '2026-01-01', '2026-01-01', '2026-01-05')).toBe('2026-04-01');
    const birthday = anchorRule({ mode: 'schedule', every: 1, unit: 'year' }, '2024-02-29');
    expect(nextDate(birthday, '2024-02-29', '2024-02-29', '2024-02-29')).toBe('2025-02-28');
  });

  it("doesn't stack up missed ones when finished late, or skip one when finished early", () => {
    const sundays = weekly([7]);
    // Due Sunday the 11th, finished Tuesday the 13th: next is Sunday the 18th, not the 11th again.
    expect(nextDate(sundays, '2026-10-04', '2026-10-11', '2026-10-13')).toBe('2026-10-18');
    // Due Sunday the 18th, finished early on the 13th: next is the 25th.
    expect(nextDate(sundays, '2026-10-04', '2026-10-18', '2026-10-13')).toBe('2026-10-25');
  });

  it('counts "after" rules from the day it was done, and waits out the off season and pauses', () => {
    const filter: Repeat = { mode: 'after', every: 3, unit: 'month' };
    expect(nextDate(filter, '2026-01-01', '2026-01-15', '2026-02-02')).toBe('2026-05-02');
    const mow: Repeat = { mode: 'schedule', every: 1, unit: 'week', weekdays: [6], months: [4, 5, 6, 7, 8, 9, 10] };
    expect(nextDate(mow, '2026-10-03', '2026-10-31', '2026-10-31')).toBe('2027-04-03');
    const haircut: Repeat = { mode: 'after', every: 6, unit: 'week', months: [3, 4, 5, 6, 7, 8, 9] };
    expect(nextDate(haircut, '2026-01-01', null, '2026-09-01')).toBe('2027-03-01');
    expect(nextDate(weekly([7]), '2026-10-04', '2026-10-11', '2026-10-11', '2026-11-01')).toBe('2026-11-01');
  });

  it('cleans rules and refuses broken ones', () => {
    expect(cleanRepeat({ mode: 'schedule', every: 1, unit: 'week', weekdays: [7, 3, 3, 9], months: [] })).toEqual(weekly([3, 7]));
    expect(cleanRepeat({ mode: 'after', every: 2, unit: 'week', weekdays: [1] })).toEqual({ mode: 'after', every: 2, unit: 'week' });
    expect(() => cleanRepeat({ mode: 'schedule', every: 0, unit: 'day' })).toThrow(/every/);
  });

  it('describes rules in plain words', () => {
    expect(describeRepeat(weekly([7]), null, 'en-US')).toBe('Every Sunday');
    expect(describeRepeat(weekly([1, 2, 3, 4, 5]), null, 'en-US')).toBe('Weekdays');
    expect(describeRepeat(weekly([1, 4], 2), null, 'en-US')).toBe('Every 2 weeks on Monday and Thursday');
    expect(describeRepeat({ mode: 'schedule', every: 1, unit: 'month', nth: 2, weekday: 4 }, null, 'en-US')).toBe('Monthly on the 2nd Thursday');
    expect(describeRepeat({ mode: 'schedule', every: 1, unit: 'month' }, '2026-10-01', 'en-US')).toBe('Monthly on the 1st');
    expect(describeRepeat({ mode: 'after', every: 3, unit: 'month' }, null, 'en-US')).toBe("3 months after it's done");
    expect(describeRepeat({ mode: 'schedule', every: 1, unit: 'year' }, '2026-03-14', 'en-US')).toBe('Every year on Mar 14');
    expect(describeRepeat({ ...weekly([6]), months: [4, 5, 6, 7, 8, 9, 10] }, null, 'en-US')).toBe('Every Saturday, Apr to Oct');
    expect(describeMonths([11, 12, 1, 2], 'en-US')).toBe('Nov to Feb');
  });
});

describe('repeating tasks', () => {
  let db: Db;
  let jon: Member;
  let asJon: Actor;
  let today: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    seedStarterGroups(db);
    jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon', timezone: 'America/Chicago' }).returning().get();
    asJon = { member: jon, via: 'app' };
    today = planningDate(jon);
  });

  const dow = () => Temporal.PlainDate.from(today).dayOfWeek;

  it('lands a new weekly task on its first day, and finishing it makes the next one', () => {
    const [task] = createTasks(db, asJon, [{ title: 'Water plants', subtasks: ['Ferns'], repeat: weekly([dow()]) }]);
    expect(task).toMatchObject({ plannedDate: today, repeat: { unit: 'week', weekdays: [dow()] } });
    updateTask(db, asJon, task!.id, { checkSubtasks: [task!.subtasks[0]!.id] });

    completeTasks(db, asJon, [task!.id]);
    const open = listTasks(db, jon, { query: 'Water' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ plannedDate: addDays(today, 7), subtasks: [{ title: 'Ferns', done: false }] });
    expect(open[0]!.id).not.toBe(task!.id);

    // Undo takes the new one back, so there's still only one.
    completeTasks(db, asJon, [task!.id], false);
    expect(listTasks(db, jon, { query: 'Water' }).map((t) => t.id)).toEqual([task!.id]);
  });

  it('keeps an edited next one when the completion is undone', () => {
    const [task] = createTasks(db, asJon, [{ title: 'Bins out', plannedDate: today, repeat: { mode: 'schedule', every: 1, unit: 'day' } }]);
    completeTasks(db, asJon, [task!.id]);
    const next = listTasks(db, jon, { query: 'Bins' })[0]!;
    updateTask(db, asJon, next.id, { notes: 'Recycling too' });
    completeTasks(db, asJon, [task!.id], false);
    expect(listTasks(db, jon, { query: 'Bins' })).toHaveLength(2);
  });

  it('dates "after" ones from when they were done, and skips and pauses', () => {
    const [filter] = createTasks(db, asJon, [{ title: 'Furnace filter', repeat: { mode: 'after', every: 3, unit: 'month' } }]);
    expect(filter).toMatchObject({ plannedDate: null, dueDate: null });
    completeTasks(db, asJon, [filter!.id]);
    const next = listTasks(db, jon, { query: 'Furnace' })[0]!;
    expect(next.dueDate).toBe(Temporal.PlainDate.from(today).add({ months: 3 }).toString());
    expect(skipTask(db, asJon, next.id).dueDate).toBe(Temporal.PlainDate.from(today).add({ months: 6 }).toString());

    const [chore] = createTasks(db, asJon, [{ title: 'Mop', plannedDate: today, repeat: weekly([dow()]) }]);
    expect(skipTask(db, asJon, chore!.id).plannedDate).toBe(addDays(today, 7));
    const paused = updateTask(db, asJon, chore!.id, { pausedUntil: addDays(today, 20) });
    expect(paused).toMatchObject({ plannedDate: addDays(today, 21), pausedUntil: addDays(today, 20) });
  });

  it('changes and stops a repeat, and archiving the open one ends it', () => {
    const [task] = createTasks(db, asJon, [{ title: 'Call Mom', plannedDate: today }]);
    expect(task!.repeat).toBeNull();
    const repeating = updateTask(db, asJon, task!.id, { repeat: weekly([7]) });
    expect(repeating.repeat).toMatchObject({ weekdays: [7] });
    expect(updateTask(db, asJon, task!.id, { repeat: null }).repeat).toBeNull();
    completeTasks(db, asJon, [task!.id]);
    expect(listTasks(db, jon, { query: 'Mom' })).toHaveLength(0);

    const [gone] = createTasks(db, asJon, [{ title: 'Old chore', repeat: weekly([1]) }]);
    archiveTasks(db, asJon, [gone!.id]);
    expect(getTask(db, jon, gone!.id).status).toBe('archived');
    expect(listTasks(db, jon, { query: 'Old' })).toHaveLength(0);
  });
});

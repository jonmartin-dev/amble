import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOrganize } from '../ai/apply.ts';
import { createBriefings, organizeBacklog, planMyWeek } from '../ai/plan.ts';
import { fakeAi } from '../ai/testing.ts';
import { openDatabase, type Db } from '../db/index.ts';
import { dayRecords, members, sessions, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import { resolveGroup, type Actor } from './household.ts';
import { dismissSuggestion, findGaps, getBriefing, markBriefingSeen, planWeek, score, setOutlook, suggestForDay } from './planner.ts';
import { assignTask, createTasks, getTask, listTasks, moveTasks } from './tasks.ts';

let db: Db;
let jon: Member;
let alex: Member;
let today: string;
let asJon: Actor;
let asAlex: Actor;
const weeksAgo = (n: number): Actor => ({ member: jon, via: 'app', at: new Date(Date.now() - n * 7 * 86_400_000) });

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  const add = (email: string, name: string) => db.insert(members).values({ email, name, timezone: 'America/Chicago' }).returning().get();
  jon = add('jon@example.com', 'Jon Martin');
  alex = add('alex@example.com', 'Alex Martin');
  // Pin capacity so tests don't depend on what's been learned: 120 minutes every day.
  jon = db.update(members).set({ capacity: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), 120])) }).where(eq(members.id, jon.id)).returning().get();
  asJon = { member: jon, via: 'app' };
  asAlex = { member: alex, via: 'app' };
  today = planningDate(jon);
});

describe('scores', () => {
  it('puts overdue over due today over due soon, adds must-do, and lets waiting count a little', () => {
    const s = (fields: { dueDate?: string | null; mustDo?: boolean }, createdOn = today) => score({ dueDate: null, mustDo: false, createdAt: new Date(), ...fields }, today, createdOn);
    expect(s({ dueDate: addDays(today, -2) })).toBeGreaterThan(s({ dueDate: today }));
    expect(s({ dueDate: today })).toBeGreaterThan(s({ dueDate: addDays(today, 1) }));
    expect(s({ dueDate: addDays(today, 1) })).toBeGreaterThan(s({ dueDate: addDays(today, 5) }));
    expect(s({ mustDo: true })).toBe(40);
    expect(s({}, addDays(today, -21))).toBe(15);
    expect(s({}, addDays(today, -60))).toBe(20);
    expect(s({})).toBe(0);
  });
});

describe('suggestions for today', () => {
  it('picks the most pressing backlog tasks that fit, and always the urgent ones', () => {
    createTasks(db, asJon, [{ title: 'Planned already', plannedDate: today, estimateMinutes: 60 }]);
    createTasks(db, asJon, [
      { title: 'Due today', dueDate: today, estimateMinutes: 30 },
      { title: 'Due in five days', dueDate: addDays(today, 5), estimateMinutes: 30 },
      { title: 'Brand new, nothing pressing' },
      { title: "Alex's own", assigneeId: alex.id, dueDate: today },
    ]);
    createTasks(db, weeksAgo(3), [{ title: 'Waiting three weeks', estimateMinutes: 20 }]);
    const picks = suggestForDay(db, jon);
    // 60 of 120 minutes are planned; the two due ones fill the rest, so the waiting one doesn't fit.
    expect(picks.map((p) => [p.task.title, p.why, p.fits])).toEqual([
      ['Due today', 'due', true],
      ['Due in five days', 'due', true],
    ]);
    expect(picks[0]!.reason).toBe("It's due today. It fits in the time today has left.");

    // Something due today is suggested even when the day is already full.
    createTasks(db, asJon, [{ title: 'Long job', plannedDate: today, estimateMinutes: 90 }]);
    expect(suggestForDay(db, jon).map((p) => [p.task.title, p.fits])).toEqual([['Due today', false]]);
  });

  it('explains a deadline against full days ahead, and skips what was put off', () => {
    const tomorrow = addDays(today, 1);
    createTasks(db, asJon, [{ title: 'Big job tomorrow', plannedDate: tomorrow, estimateMinutes: 120 }]);
    const [form] = createTasks(db, asJon, [{ title: 'Insurance form', dueDate: addDays(today, 2), estimateMinutes: 30 }]);
    createTasks(db, weeksAgo(2), [{ title: 'Fix the gate', estimateMinutes: 15 }]);
    const picks = suggestForDay(db, jon);
    expect(picks[0]!.task.title).toBe('Insurance form');
    expect(picks[0]!.reason).toMatch(/^Due \w+, and tomorrow looks full\./);
    expect(picks[1]).toMatchObject({ why: 'waiting', reason: "It's been waiting 2 weeks. A quick one." });

    dismissSuggestion(db, jon, form!.id);
    expect(getBriefing(db, jon).suggestions.map((s) => s.task.title)).toEqual(['Fix the gate']);
  });

  it("saves the last pick for something that matters but isn't due, and not a third quick one", () => {
    createTasks(db, asJon, [
      { title: 'Due in two days', dueDate: addDays(today, 2), estimateMinutes: 10 },
      { title: 'Due in three days', dueDate: addDays(today, 3), estimateMinutes: 10 },
      { title: 'Due in four days', dueDate: addDays(today, 4), estimateMinutes: 10 },
    ]);
    createTasks(db, weeksAgo(3), [
      { title: 'Sort the mail', estimateMinutes: 10 },
      { title: 'Clean the gutters', estimateMinutes: 60 },
    ]);
    expect(suggestForDay(db, jon).map((p) => [p.task.title, p.why])).toEqual([
      ['Due in two days', 'due'],
      ['Due in three days', 'due'],
      ['Clean the gutters', 'waiting'],
    ]);

    // Nothing due today gives way for it, though.
    createTasks(db, asJon, [1, 2, 3].map((i) => ({ title: `Due today ${i}`, dueDate: today, estimateMinutes: 10 })));
    expect(suggestForDay(db, jon).every((p) => p.task.title.startsWith('Due today'))).toBe(true);
  });

  it('on a rough day, suggests only must-dos and what is due today', () => {
    createTasks(db, asJon, [
      { title: 'Due today', dueDate: today, estimateMinutes: 10 },
      { title: 'Due tomorrow', dueDate: addDays(today, 1), estimateMinutes: 10 },
      { title: 'Must do', mustDo: true, estimateMinutes: 10 },
    ]);
    expect(suggestForDay(db, jon)).toHaveLength(3);
    setOutlook(db, jon, 'rough');
    expect(suggestForDay(db, jon).map((p) => p.task.title)).toEqual(['Due today', 'Must do']);
  });
});

describe('the morning briefing', () => {
  it("shows the day, what was handed over and what's left from earlier, until it's been seen", () => {
    const [left] = createTasks(db, asJon, [{ title: 'Left from yesterday', plannedDate: addDays(today, -1) }]);
    createTasks(db, asAlex, [{ title: 'Call the plumber', assigneeId: jon.id }]);
    const [mine] = createTasks(db, asAlex, [{ title: 'Pick up the cake' }]);
    assignTask(db, asAlex, mine!.id, jon.id, 'Bakery closes at 6');
    createTasks(db, asAlex, [{ title: "Alex's own thing" }]);
    const briefing = getBriefing(db, jon);
    expect(briefing).toMatchObject({ date: today, seen: false, greeting: expect.stringMatching(/^Good (morning|afternoon|evening), Jon$/) });
    expect(briefing.handedOver.map((h) => [h.task.title, h.from, h.note])).toEqual([
      ['Pick up the cake', 'Alex', 'Bakery closes at 6'],
      ['Call the plumber', 'Alex', null],
    ]);
    expect(briefing.carriedOver.map((t) => t.id)).toEqual([left!.id]);
    markBriefingSeen(db, jon);
    expect(getBriefing(db, jon).seen).toBe(true);
  });

  it('names what on today can wait, and keeps how the day is looking', () => {
    createTasks(db, asJon, [
      { title: 'Fold the laundry', plannedDate: today, estimateMinutes: 30 },
      { title: 'Pay the rent', plannedDate: today, dueDate: today, estimateMinutes: 10 },
      { title: 'Call the vet', plannedDate: today, mustDo: true },
    ]);
    createTasks(db, asAlex, [{ title: "Alex's laundry", plannedDate: today, assigneeId: alex.id }]);
    const briefing = getBriefing(db, jon);
    expect(briefing.outlook).toBeNull();
    expect(briefing.canWait.map((t) => t.title)).toEqual(['Fold the laundry']);
    setOutlook(db, jon, 'rough');
    // 120 minutes pinned, and a rough day keeps 60% of it.
    expect(getBriefing(db, jon)).toMatchObject({ outlook: 'rough', load: { capacityMinutes: 70, baseCapacityMinutes: 120 } });
    // Alex sees Jon's day with less room, and never why.
    expect(getBriefing(db, alex).outlook).toBeNull();
  });

  it("writes the day's reasons once, ahead of time, with Haiku's wording", async () => {
    createTasks(db, asJon, [{ title: 'Renew the registration', dueDate: addDays(today, 1), estimateMinutes: 20 }]);
    db.insert(sessions).values({ tokenHash: 'x', memberId: jon.id, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }).run();
    const ai = fakeAi(({ content }) => {
      expect(content).toContain('t1 Renew the registration');
      return { reasons: [{ task: 't1', reason: 'Due tomorrow, and today has room.' }] };
    });
    const briefings = createBriefings(db, ai, 'America/Chicago');
    await briefings.run();
    await briefings.run();
    expect(ai.requests).toHaveLength(1);
    expect(db.select().from(dayRecords).where(eq(dayRecords.memberId, jon.id)).get()).toMatchObject({ reasonsBy: 'ai' });
    expect(getBriefing(db, jon).suggestions.map((s) => s.reason)).toEqual(['Due tomorrow, and today has room.']);
  });
});

describe('finding days', () => {
  it('spreads tasks with deadlines over the lightest days, counting each pick toward the next', () => {
    createTasks(db, asJon, [{ title: 'Busy today', plannedDate: today, estimateMinutes: 90 }]);
    createTasks(db, asJon, [
      { title: 'A', dueDate: addDays(today, 2), estimateMinutes: 60 },
      { title: 'B', dueDate: addDays(today, 2), estimateMinutes: 60 },
      { title: 'Due next month', dueDate: addDays(today, 45) },
    ]);
    const gaps = findGaps(db, jon);
    expect(gaps.map((g) => [g.task.title, g.date])).toEqual([
      ['A', addDays(today, 1)],
      ['B', addDays(today, 2)],
    ]);
    expect(gaps[1]!.reason).toBe("Day after tomorrow still has room, and it's due then.".replace('Day after tomorrow', capitalWeekday(addDays(today, 2))));
  });

  it('plans a week: leftovers and deadlines first, filling days to 85%, and keeps the rest in the backlog', () => {
    createTasks(db, asJon, [{ title: 'Left over', plannedDate: addDays(today, -2), estimateMinutes: 60 }]);
    createTasks(db, asJon, [{ title: 'Due Thursday-ish', dueDate: addDays(today, 3), estimateMinutes: 90 }]);
    createTasks(db, weeksAgo(1), Array.from({ length: 12 }, (_, i) => ({ title: `Chore ${i}`, estimateMinutes: 60 })));
    const plan = planWeek(db, jon);
    const titles = plan.picks.map((p) => p.task.title);
    expect(titles.slice(0, 2)).toEqual(['Left over', 'Due Thursday-ish']);
    expect(plan.picks.find((p) => p.task.title === 'Due Thursday-ish')!.date <= addDays(today, 3)).toBe(true);
    // 120 minutes a day at 85% fits one 60-minute chore a day after the two above: seven days, one
    // of which holds the 90-minute task and one the 60-minute leftover.
    for (const d of plan.days) expect(d.plannedMinutes).toBeLessThanOrEqual(120);
    expect(titles.filter((t) => t.startsWith('Chore'))).toHaveLength(5);
  });

  it('fills days only as full as someone likes them', () => {
    const picks = (dayFill: Member['dayFill']) => {
      jon = db.update(members).set({ dayFill }).where(eq(members.id, jon.id)).returning().get();
      return planWeek(db, jon).picks.length;
    };
    // 120 minutes a day: 70% of it holds one 50-minute chore and 85% two.
    createTasks(db, weeksAgo(1), Array.from({ length: 14 }, (_, i) => ({ title: `Chore ${i}`, estimateMinutes: 50 })));
    expect(picks('roomy')).toBe(7);
    expect(picks('balanced')).toBe(14);
  });

  it('fills days all the way for someone who likes them packed', () => {
    const picks = (dayFill: Member['dayFill']) => {
      jon = db.update(members).set({ dayFill }).where(eq(members.id, jon.id)).returning().get();
      return planWeek(db, jon).picks.length;
    };
    createTasks(db, weeksAgo(1), Array.from({ length: 14 }, (_, i) => ({ title: `Chore ${i}`, estimateMinutes: 60 })));
    expect(picks('balanced')).toBe(7);
    expect(picks('packed')).toBe(14);
  });

  it("lets Haiku follow what someone said, but never past a deadline or outside the week", async () => {
    const [due] = createTasks(db, asJon, [{ title: 'Pay the bill', dueDate: addDays(today, 2), estimateMinutes: 10 }]);
    const [chore] = createTasks(db, weeksAgo(2), [{ title: 'Wash the car', estimateMinutes: 45 }]);
    const ai = fakeAi(({ content }) => {
      expect(content).toContain('They said: """keep the weekend free"""');
      const ref = (title: string) => content.split('\n').find((l) => l.includes(title))!.split(' ')[0]!;
      return {
        plan: [
          { task: ref('Pay the bill'), day: addDays(today, 5), reason: 'Later is fine.' },
          { task: ref('Wash the car'), day: addDays(today, 30), reason: 'Out of range.' },
        ],
        note: 'A light week.',
      };
    });
    const week = await planMyWeek(db, ai, jon, { note: 'keep the weekend free', timezone: 'America/Chicago' });
    expect(week).toMatchObject({ by: 'ai', note: 'A light week.' });
    expect(week.picks.map((p) => [p.task.id, p.date])).toEqual([[due!.id, addDays(today, 2)]]);
    expect(week.picks.some((p) => p.task.id === chore!.id)).toBe(false);
  });
});

describe('organizing the backlog', () => {
  it('checks Haiku\'s suggestions against the backlog, and applies regroup, merge and split', async () => {
    const home = resolveGroup(db, jon, 'Home');
    const errands = resolveGroup(db, jon, 'Errands');
    const [stray, dup1, dup2, combo] = createTasks(db, asJon, [
      { title: 'Buy stamps' },
      { title: 'Call dentist', notes: 'Dr. Lee', subtasks: ['Find insurance card'] },
      { title: 'Phone the dentist', dueDate: addDays(today, 3), mustDo: true },
      { title: 'Clean garage and fix bike', groupId: home.id, dueDate: addDays(today, 6) },
    ]);
    const ai = fakeAi(({ content }) => {
      const ref = (title: string) => content.split('\n').find((l) => l.includes(title))!.split(' ')[0]!;
      const group = (name: string) => content.split('\n').find((l) => l.endsWith(` ${name}`))!.split(' ')[0]!;
      return {
        suggestions: [
          { kind: 'regroup', task: ref('Buy stamps'), group: group('Errands'), reason: 'It is an errand.' },
          { kind: 'regroup', task: 't999', group: 'g1', reason: 'Unknown task.' },
          { kind: 'merge', tasks: [ref('Call dentist'), ref('Phone the dentist')], title: 'Call the dentist', reason: 'Same thing twice.' },
          { kind: 'split', task: ref('Clean garage'), into: ['Clean the garage', 'Fix the bike'], reason: 'Two jobs.' },
          { kind: 'split', task: ref('Buy stamps'), into: ['One', 'Two'], reason: 'Already used.' },
        ],
      };
    });
    const found = await organizeBacklog(db, ai, jon, 'America/Chicago');
    expect(found.map((s) => s.kind)).toEqual(['regroup', 'merge', 'split']);

    applyOrganize(db, asJon, found[0]!);
    expect(getTask(db, jon, stray!.id).groupId).toBe(errands.id);

    applyOrganize(db, asJon, found[1]!);
    expect(getTask(db, jon, dup1!.id)).toMatchObject({ title: 'Call the dentist', dueDate: addDays(today, 3), mustDo: true, notes: 'Dr. Lee' });
    expect(getTask(db, jon, dup2!.id).status).toBe('archived');

    const { taskIds } = applyOrganize(db, asJon, found[2]!);
    expect(taskIds.map((id) => getTask(db, jon, id))).toMatchObject([
      { title: 'Clean the garage', groupId: home.id, dueDate: addDays(today, 6) },
      { title: 'Fix the bike', groupId: home.id },
    ]);
    expect(getTask(db, jon, combo!.id).status).toBe('archived');
    expect(listTasks(db, jon).map((t) => t.title).sort()).toEqual(['Buy stamps', 'Call the dentist', 'Clean the garage', 'Fix the bike']);
  });
});

function capitalWeekday(date: string) {
  return Temporal.PlainDate.from(date).toLocaleString('en-US', { weekday: 'long' });
}

// moveTasks is imported for parity with the app's flows; keep the linter quiet.
void moveTasks;

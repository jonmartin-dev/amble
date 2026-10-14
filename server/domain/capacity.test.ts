import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.ts';
import { activity, members, tasks, type Member } from '../db/schema.ts';
import { addDays, planningDate, planningDayStart } from '../lib/dates.ts';
import { capacityFor, defaultCapacity, getLoad, learnedCapacity } from './load.ts';

let db: Db;
let jon: Member;
let today: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon', timezone: 'America/Chicago' }).returning().get();
  today = planningDate(jon);
});

/** Records Jon finishing tasks worth these minutes, midday on a past date. */
function finished(date: string, ...minutes: (number | null)[]) {
  const at = new Date(planningDayStart(jon, date).getTime() + 8 * 3600_000);
  for (const m of minutes) {
    db.insert(tasks)
      .values({ title: 'Chore', status: 'done', estimateMinutes: m, completedAt: at, completedById: jon.id, updatedAt: at })
      .run();
  }
}

/** The same weekday as today, `weeksAgo` weeks back. */
const weeksAgo = (n: number) => addDays(today, -7 * n);
const dow = () => Temporal.PlainDate.from(today).dayOfWeek;

describe('learned capacity', () => {
  it('starts at the defaults with no history', () => {
    const learned = learnedCapacity(db, jon);
    expect(learned.map((d) => d.minutes)).toEqual([1, 2, 3, 4, 5, 6, 7].map(defaultCapacity));
    expect(learned.every((d) => d.samples === 0 && d.confidence === 0)).toBe(true);
  });

  it("moves toward a good day's worth as weeks of history build up", () => {
    // Six weeks of this weekday: 60, 60, 90, 90, 120, 120 minutes finished.
    // Unestimated tasks count as 30, so the first day is two of them.
    finished(weeksAgo(1), null, null);
    [60, 90, 90, 120, 120].forEach((m, i) => finished(weeksAgo(i + 2), m));
    const day = learnedCapacity(db, jon).find((d) => d.weekday === dow())!;
    expect(day).toMatchObject({ samples: 6, confidence: 1 });
    // The 75th percentile of [60, 60, 90, 90, 120, 120] is 112.5, rounded to 15 minutes.
    expect(day.minutes).toBe(120);
    expect(getLoad(db, jon, jon, today, today)[0]!.capacityMinutes).toBe(120);
  });

  it('blends with the default while history is thin, and ignores days Almanac went unused', () => {
    finished(weeksAgo(1), 60);
    finished(weeksAgo(2), 60);
    const day = learnedCapacity(db, jon).find((d) => d.weekday === dow())!;
    const base = defaultCapacity(dow());
    expect(day.samples).toBe(2);
    expect(day.minutes).toBe(Math.round(((2 / 3) * base + (1 / 3) * 60) / 15) * 15);
  });

  it('counts a day used without finishing anything as a light day', () => {
    for (let i = 1; i <= 6; i++) {
      const at = new Date(planningDayStart(jon, weeksAgo(i)).getTime() + 3600_000);
      db.insert(activity).values({ memberId: jon.id, action: 'task.created', createdAt: at }).run();
    }
    // Nothing finished, so it bottoms out at the floor rather than zero.
    expect(learnedCapacity(db, jon).find((d) => d.weekday === dow())!.minutes).toBe(60);
  });

  it('lets a pinned number win over what was learned', () => {
    for (let i = 1; i <= 6; i++) finished(weeksAgo(i), 120);
    const learned = learnedCapacity(db, jon);
    expect(capacityFor(today, jon, learned)).toBe(120);
    expect(capacityFor(today, { capacity: { [String(dow())]: 45 } }, learned)).toBe(45);
  });
});

import { and, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { activity, tasks, type Member } from '../db/schema.ts';
import { addDays, dateOf, dateRange, daysBetween, isWeekend, planningDate, planningDayStart, weekday } from '../lib/dates.ts';
import { DomainError } from './household.ts';
import { listTasks } from './tasks.ts';

// Capacity starts at these defaults and is learned from what each member finishes. Anyone can pin
// their own number per weekday in Settings, which wins over what was learned.
export const DEFAULT_ESTIMATE_MINUTES = 30;
export const DEFAULT_CAPACITY = { weekday: 180, weekend: 240 };
export const MAX_CAPACITY_MINUTES = 720;
const LEARN_WEEKS = 12;
// This many same-weekday samples (about six weeks of use) and the default no longer counts.
const FULL_WEIGHT_SAMPLES = 6;
// Learning never takes a day below half its starting point: a few quiet weeks shouldn't turn an
// ordinary plan into "Too much". Pinning a number (0 for a day off) is how to go lower.
const MIN_LEARNED_SHARE = 0.5;
const MAX_RANGE_DAYS = 62;

export type LoadLevel = 'light' | 'moderate' | 'full' | 'over';

export interface DayLoad {
  date: string;
  weekday: string;
  tasks: number;
  mustDo: number;
  plannedMinutes: number;
  /** Tasks with no estimate, counted at the default. */
  guessed: number;
  capacityMinutes: number;
  level: LoadLevel;
}

export function defaultCapacity(isoWeekday: number) {
  return isoWeekday >= 6 ? DEFAULT_CAPACITY.weekend : DEFAULT_CAPACITY.weekday;
}

export interface LearnedDay {
  /** ISO weekday, 1 is Monday. */
  weekday: number;
  minutes: number;
  /** Days of this weekday the member used Almanac in the window. */
  samples: number;
  /** How much of `minutes` comes from history rather than the default, 0 to 1. */
  confidence: number;
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo]! + (sorted[Math.ceil(i)]! - sorted[lo]!) * (i - lo);
}

/**
 * Capacity per weekday learned from what this member actually finished over recent weeks. A
 * day counts once they used Almanac at all; its sample is the minutes they finished (estimates,
 * or 30 for unestimated tasks). A good day's worth, the 75th percentile, is the target, blended
 * with the default until there are enough samples to trust it.
 */
export function learnedCapacity(db: Db, member: Member, today = planningDate(member)): LearnedDay[] {
  const start = addDays(today, -LEARN_WEEKS * 7);
  const from = planningDayStart(member, start);
  const until = planningDayStart(member, today);
  const active = new Set(
    db
      .select({ at: activity.createdAt })
      .from(activity)
      .where(and(eq(activity.memberId, member.id), gte(activity.createdAt, from), lt(activity.createdAt, until)))
      .all()
      .map((a) => dateOf(member, a.at)),
  );
  const finished = new Map<string, number>();
  for (const t of db
    .select({ at: tasks.completedAt, minutes: tasks.estimateMinutes })
    .from(tasks)
    .where(and(eq(tasks.completedById, member.id), gte(tasks.completedAt, from), lt(tasks.completedAt, until)))
    .all()) {
    const day = dateOf(member, t.at!);
    active.add(day);
    finished.set(day, (finished.get(day) ?? 0) + (t.minutes ?? DEFAULT_ESTIMATE_MINUTES));
  }
  return [1, 2, 3, 4, 5, 6, 7].map((dow) => {
    const samples = [...active].filter((d) => Temporal.PlainDate.from(d).dayOfWeek === dow).map((d) => finished.get(d) ?? 0);
    const base = defaultCapacity(dow);
    if (samples.length === 0) return { weekday: dow, minutes: base, samples: 0, confidence: 0 };
    const confidence = Math.min(samples.length / FULL_WEIGHT_SAMPLES, 1);
    const observed = Math.max(percentile(samples, 0.75), base * MIN_LEARNED_SHARE);
    const blended = (1 - confidence) * base + confidence * observed;
    const minutes = Math.min(Math.round(blended / 15) * 15, MAX_CAPACITY_MINUTES);
    return { weekday: dow, minutes, samples: samples.length, confidence: Math.round(confidence * 100) / 100 };
  });
}

/**
 * Task minutes that fit on a date for this member: the number they pinned for that weekday, else
 * what Almanac learned, else the default.
 */
export function capacityFor(date: string, member?: Pick<Member, 'capacity'>, learned?: LearnedDay[]) {
  const dow = Temporal.PlainDate.from(date).dayOfWeek;
  const pinned = member?.capacity?.[String(dow)];
  if (pinned != null) return pinned;
  return learned?.find((d) => d.weekday === dow)?.minutes ?? (isWeekend(date) ? DEFAULT_CAPACITY.weekend : DEFAULT_CAPACITY.weekday);
}

function level(minutes: number, capacity: number): LoadLevel {
  // A day off has no room, so anything on it is too much.
  if (capacity === 0) return minutes > 0 ? 'over' : 'light';
  const ratio = minutes / capacity;
  if (ratio < 0.5) return 'light';
  if (ratio < 0.85) return 'moderate';
  if (ratio <= 1) return 'full';
  return 'over';
}

/** How full each day is for one member: their planned tasks plus shared ones, against capacity. */
export function getLoad(db: Db, me: Member, forMember: Member, start: string, end: string): DayLoad[] {
  if (end < start) throw new DomainError('The end date is before the start date.');
  if (daysBetween(start, end) >= MAX_RANGE_DAYS) throw new DomainError(`Ask for ${MAX_RANGE_DAYS} days or fewer at a time.`);
  const planned = listTasks(db, me, {
    plannedFrom: start,
    plannedTo: end,
    assignee: { memberId: forMember.id, includeShared: true },
  });
  const learned = learnedCapacity(db, forMember);
  return dateRange(start, end).map((date) => {
    const day = planned.filter((t) => t.plannedDate === date);
    const minutes = day.reduce((sum, t) => sum + (t.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES), 0);
    const capacity = capacityFor(date, forMember, learned);
    return {
      date,
      weekday: weekday(date),
      tasks: day.length,
      mustDo: day.filter((t) => t.mustDo).length,
      plannedMinutes: minutes,
      guessed: day.filter((t) => t.estimateMinutes == null).length,
      capacityMinutes: capacity,
      level: level(minutes, capacity),
    };
  });
}

/**
 * Picks the day between today and the due date with the most room left after adding the task.
 * Ties go to the earlier day, and a day that would go over capacity loses to any day that wouldn't.
 */
export function findGap(db: Db, me: Member, forMember: Member, dueDate: string, estimateMinutes?: number | null) {
  const today = planningDate(forMember);
  if (dueDate < today) throw new DomainError(`${dueDate} has already passed. Plan it for today (${today}) instead.`);
  const end = daysBetween(today, dueDate) >= MAX_RANGE_DAYS ? addDays(today, MAX_RANGE_DAYS - 1) : dueDate;
  const minutes = estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES;
  const days = getLoad(db, me, forMember, today, end).map((d) => {
    const after = d.plannedMinutes + minutes;
    // Round to 5% so near-equal days count as a tie and the earlier one wins.
    const score = d.capacityMinutes ? Math.round((after / d.capacityMinutes) * 20) : Infinity;
    return { ...d, after, fits: after <= d.capacityMinutes, score };
  });
  const ranked = [...days].sort((a, b) => Number(b.fits) - Number(a.fits) || a.score - b.score || (a.date < b.date ? -1 : 1));
  const best = ranked[0]!;
  const room = best.capacityMinutes - best.plannedMinutes;
  const reason = best.fits
    ? `${best.weekday} ${best.date} has the most room before ${dueDate === end ? `it's due` : 'the end of the window'}: ${best.plannedMinutes} of ${best.capacityMinutes} minutes planned, so ${minutes} more still fits.`
    : `Every day through ${end} is already full. ${best.weekday} ${best.date} is the lightest, with ${Math.max(room, 0)} minutes free.`;
  return {
    date: best.date,
    weekday: best.weekday,
    fits: best.fits,
    reason,
    estimateMinutes: minutes,
    alternatives: ranked.slice(1, 3).map(({ date, weekday, plannedMinutes, capacityMinutes, fits }) => ({
      date,
      weekday,
      plannedMinutes,
      capacityMinutes,
      fits,
    })),
  };
}

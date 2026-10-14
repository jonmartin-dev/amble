import type { Db } from '../db/index.ts';
import type { Member } from '../db/schema.ts';
import { addDays, dateRange, daysBetween, isWeekend, planningDate, weekday } from '../lib/dates.ts';
import { DomainError } from './household.ts';
import { listTasks } from './tasks.ts';

// Until Almanac learns real capacity and estimates (phase 5), these stand in.
export const DEFAULT_ESTIMATE_MINUTES = 30;
const WEEKDAY_CAPACITY = 180;
const WEEKEND_CAPACITY = 240;
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

export function capacityFor(date: string) {
  return isWeekend(date) ? WEEKEND_CAPACITY : WEEKDAY_CAPACITY;
}

function level(minutes: number, capacity: number): LoadLevel {
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
  return dateRange(start, end).map((date) => {
    const day = planned.filter((t) => t.plannedDate === date);
    const minutes = day.reduce((sum, t) => sum + (t.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES), 0);
    const capacity = capacityFor(date);
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
    return { ...d, after, fits: after <= d.capacityMinutes, score: Math.round((after / d.capacityMinutes) * 20) };
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

// When repeating tasks come back. A series holds the rule; only one open task per series exists
// at a time, and finishing it makes the next one.
import { z } from 'zod';
import type { Repeat } from '../../shared/repeat.ts';
import { DomainError } from './household.ts';

export type { Repeat };

const MAX_SEARCH_DAYS = 3700; // about ten years, enough for "every 5 years in June"

function plain(date: string) {
  return Temporal.PlainDate.from(date);
}

/** Checks a rule from the app, the connector or smart add, and drops fields that don't apply. */
export function cleanRepeat(input: Repeat): Repeat {
  const int = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
  const every = int(input.every, 1, 365);
  if (!every) throw new DomainError('A repeat needs "every" to be a whole number from 1 to 365.');
  if (!['day', 'week', 'month', 'year'].includes(input.unit)) throw new DomainError(`"${input.unit}" isn't a repeat unit.`);
  if (input.mode !== 'schedule' && input.mode !== 'after') throw new DomainError(`"${input.mode}" isn't a repeat mode.`);
  const out: Repeat = { mode: input.mode, every, unit: input.unit };
  const days = (list: unknown, hi: number) =>
    Array.isArray(list) ? [...new Set(list.filter((d) => int(d, 1, hi) != null) as number[])].sort((a, b) => a - b) : [];
  if (input.mode === 'schedule') {
    if (input.unit === 'week') {
      const weekdays = days(input.weekdays, 7);
      if (weekdays.length) out.weekdays = weekdays;
    }
    if (input.unit === 'month') {
      const nth = input.nth === -1 ? -1 : int(input.nth, 1, 4);
      const weekday = int(input.weekday, 1, 7);
      if (nth && weekday) Object.assign(out, { nth, weekday });
      else {
        const day = input.day === -1 ? -1 : int(input.day, 1, 31);
        if (day) out.day = day;
      }
    }
    if (input.unit === 'year') {
      const month = int(input.month, 1, 12);
      const day = input.day === -1 ? -1 : int(input.day, 1, 31);
      if (month) out.month = month;
      if (day) out.day = day;
    }
  }
  const months = days(input.months, 12);
  if (months.length && months.length < 12) out.months = months;
  if (input.on === 'planned' || input.on === 'due') out.on = input.on;
  return out;
}

/** Fills in what a rule leaves to its first date (which weekday, which day of the month). */
export function anchorRule(r: Repeat, anchor: string): Repeat {
  const a = plain(anchor);
  if (r.mode !== 'schedule') return r;
  if (r.unit === 'week' && !r.weekdays?.length) return { ...r, weekdays: [a.dayOfWeek] };
  if (r.unit === 'month' && !(r.nth && r.weekday) && r.day == null) return { ...r, day: a.day };
  if (r.unit === 'year') return { ...r, month: r.month ?? a.month, day: r.day ?? a.day };
  return r;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

function dayMatches(want: number, d: Temporal.PlainDate) {
  return want === -1 ? d.day === d.daysInMonth : d.day === Math.min(want, d.daysInMonth);
}

function inSeason(r: Repeat, d: Temporal.PlainDate) {
  return !r.months?.length || r.months.includes(d.month);
}

/** Whether a date is one of the rule's dates, counting intervals from the anchor. */
export function matches(rule: Repeat, anchor: string, date: string): boolean {
  const r = anchorRule(rule, anchor);
  const a = plain(anchor);
  const d = plain(date);
  if (!inSeason(r, d)) return false;
  switch (r.unit) {
    case 'day':
      return mod(a.until(d, { largestUnit: 'days' }).days, r.every) === 0;
    case 'week': {
      if (!r.weekdays!.includes(d.dayOfWeek)) return false;
      const weeks = Math.floor(a.subtract({ days: a.dayOfWeek - 1 }).until(d.subtract({ days: d.dayOfWeek - 1 }), { largestUnit: 'days' }).days / 7);
      return mod(weeks, r.every) === 0;
    }
    case 'month': {
      const months = (d.year - a.year) * 12 + (d.month - a.month);
      if (mod(months, r.every) !== 0) return false;
      if (r.nth && r.weekday) {
        if (d.dayOfWeek !== r.weekday) return false;
        return r.nth === -1 ? d.day + 7 > d.daysInMonth : Math.ceil(d.day / 7) === r.nth;
      }
      return dayMatches(r.day!, d);
    }
    case 'year':
      return mod(d.year - a.year, r.every) === 0 && d.month === r.month && dayMatches(r.day!, d);
  }
}

/** The first of the rule's dates on or after `from` (and not before a pause ends). */
export function firstOccurrence(rule: Repeat, anchor: string, from: string, pausedUntil?: string | null): string | null {
  let d = plain(pausedUntil && pausedUntil > from ? pausedUntil : from);
  for (let i = 0; i < MAX_SEARCH_DAYS; i++, d = d.add({ days: 1 })) {
    if (matches(rule, anchor, d.toString())) return d.toString();
  }
  return null;
}

/**
 * The date for the next one after finishing this one. Scheduled rules take the next date after
 * both this one's date and today, so finishing late doesn't stack up missed ones. "After" rules
 * count from the day it was done.
 */
export function nextDate(rule: Repeat, anchor: string, current: string | null, doneOn: string, pausedUntil?: string | null): string | null {
  if (rule.mode === 'after') {
    const n = rule.every;
    let d = plain(doneOn).add(
      rule.unit === 'day' ? { days: n } : rule.unit === 'week' ? { weeks: n } : rule.unit === 'month' ? { months: n } : { years: n },
    );
    if (pausedUntil && d.toString() < pausedUntil) d = plain(pausedUntil);
    // Out of season, it waits for the first day of the next month in season.
    for (let i = 0; i < 12 && !inSeason(rule, d); i++) d = d.with({ day: 1 }).add({ months: 1 });
    return d.toString();
  }
  const after = current && current > doneOn ? current : doneOn;
  return firstOccurrence(rule, anchor, plain(after).add({ days: 1 }).toString(), pausedUntil);
}

/** A repeat rule as the API and the Claude connector accept it. */
export const repeatSchema = z.object({
  mode: z.enum(['schedule', 'after']).describe('"schedule" follows the calendar; "after" comes back a set time after the last one was done'),
  every: z.number().int().min(1).max(365).describe('Every this many units, e.g. 2 for every other week'),
  unit: z.enum(['day', 'week', 'month', 'year']),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional().describe('Weekly: days, 1 = Monday ... 7 = Sunday'),
  day: z.number().int().min(-1).max(31).nullable().optional().describe('Monthly or yearly: day of the month, -1 for the last day'),
  nth: z.number().int().min(-1).max(4).nullable().optional().describe('Monthly: which weekday of the month (1-4, -1 for last), with weekday'),
  weekday: z.number().int().min(1).max(7).nullable().optional().describe('Monthly with nth: 1 = Monday ... 7 = Sunday'),
  month: z.number().int().min(1).max(12).nullable().optional().describe('Yearly: the month'),
  months: z.array(z.number().int().min(1).max(12)).max(12).nullable().optional().describe('Only in these months, for seasonal chores'),
  on: z.enum(['planned', 'due']).nullable().optional().describe('Each one goes on that day\'s list ("planned", the default for schedule) or is due by it ("due", the default for after)'),
});

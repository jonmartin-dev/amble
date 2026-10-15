// Calendar events as Amble uses them: what's on someone's calendar each day, and how much of the
// day it takes up.
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { calendarEvents, calendarSources, type Member } from '../db/schema.ts';
import { addDays, dateRange } from '../lib/dates.ts';

// Busy time counts within waking hours, so an overnight flight or a late party doesn't eat a whole
// day's room.
const DAY_STARTS = 7;
const DAY_ENDS = 22;
/** Minutes in the waking day busy time is counted in. */
export const WAKING_MINUTES = (DAY_ENDS - DAY_STARTS) * 60;
// The usual busy time for a weekday is the median over this many weeks before today.
const USUAL_WEEKS = 8;

export interface EventView {
  id: string;
  title: string | null;
  allDay: boolean;
  start: string;
  end: string;
  /** All-day events: the first date, and the day after the last (as Google gives them). */
  startDate: string | null;
  endDate: string | null;
  busy: boolean;
  calendar: string;
  color: string | null;
  url: string | null;
}

interface Row {
  id: string;
  uid: string | null;
  eventId: string;
  title: string | null;
  allDay: boolean;
  startAt: Date;
  endAt: Date;
  startDate: string | null;
  endDate: string | null;
  busy: boolean;
  url: string | null;
  calendar: string;
  color: string | null;
}

function at(date: string, hour: number, timeZone: string) {
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime: { hour } }).epochMilliseconds;
}

const midnight = (date: string, timeZone: string) => Temporal.PlainDate.from(date).toZonedDateTime({ timeZone }).epochMilliseconds;

/** Events on calendars that count, overlapping start..end (inclusive dates in the member's timezone). */
function rows(db: Db, member: Pick<Member, 'id' | 'timezone'>, start: string, end: string): Row[] {
  const from = new Date(midnight(start, member.timezone));
  const to = new Date(midnight(addDays(end, 1), member.timezone));
  const found = db
    .select({
      id: calendarEvents.id,
      uid: calendarEvents.uid,
      eventId: calendarEvents.eventId,
      title: calendarEvents.title,
      allDay: calendarEvents.allDay,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      startDate: calendarEvents.startDate,
      endDate: calendarEvents.endDate,
      busy: calendarEvents.busy,
      url: calendarEvents.url,
      calendar: calendarSources.name,
      color: calendarSources.color,
    })
    .from(calendarEvents)
    .innerJoin(calendarSources, eq(calendarEvents.sourceId, calendarSources.id))
    .where(and(eq(calendarEvents.memberId, member.id), eq(calendarSources.counts, true), lt(calendarEvents.startAt, to), gt(calendarEvents.endAt, from)))
    .orderBy(asc(calendarEvents.startAt))
    .all();
  // The same meeting on two calendars (a shared one and your own) shows once.
  const seen = new Set<string>();
  return found.filter((r) => {
    const key = `${r.uid ?? r.eventId}|${r.startAt.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Someone's own events between two dates, all-day ones first. */
export function listEvents(db: Db, member: Member, start: string, end: string): EventView[] {
  return rows(db, member, start, end)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt.getTime() - b.startAt.getTime())
    .map((r) => ({
      id: r.id,
      title: r.title,
      allDay: r.allDay,
      start: r.startAt.toISOString(),
      end: r.endAt.toISOString(),
      startDate: r.startDate,
      endDate: r.endDate,
      busy: r.busy,
      calendar: r.calendar,
      color: r.color,
      url: r.url,
    }));
}

export interface DayBusy {
  /** Busy minutes between 7am and 10pm, with overlapping events counted once. */
  minutes: number;
  /** Busy events touching the day. */
  events: number;
}

/** How much of each day between two dates someone's calendar takes up. */
export function busyByDay(db: Db, member: Pick<Member, 'id' | 'timezone'>, start: string, end: string): Map<string, DayBusy> {
  const busy = rows(db, member, start, end).filter((r) => r.busy);
  const out = new Map<string, DayBusy>();
  for (const date of dateRange(start, end)) {
    const dayFrom = midnight(date, member.timezone);
    const dayTo = midnight(addDays(date, 1), member.timezone);
    const winFrom = at(date, DAY_STARTS, member.timezone);
    const winTo = at(date, DAY_ENDS, member.timezone);
    const spans: [number, number][] = [];
    let events = 0;
    for (const r of busy) {
      const s = r.startAt.getTime();
      const e = r.endAt.getTime();
      if (!(s < dayTo && e > dayFrom)) continue;
      events++;
      // An all-day event marked busy (a trip, a day out of office) fills the day.
      const from = r.allDay ? winFrom : Math.max(s, winFrom);
      const to = r.allDay ? winTo : Math.min(e, winTo);
      if (to > from) spans.push([from, to]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let minutes = 0;
    let cur: [number, number] | null = null;
    for (const span of spans) {
      if (cur && span[0] <= cur[1]) cur[1] = Math.max(cur[1], span[1]);
      else {
        if (cur) minutes += cur[1] - cur[0];
        cur = [...span];
      }
    }
    if (cur) minutes += cur[1] - cur[0];
    out.set(date, { minutes: Math.round(minutes / 60_000), events });
  }
  return out;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * A usual amount of busy time for each ISO weekday (1 is Monday): the median of the weeks before
 * `today`. A standing work schedule is usual; a dentist appointment on top of it is not.
 */
export function usualBusy(db: Db, member: Pick<Member, 'id' | 'timezone'>, today: string): Map<number, number> {
  const days = busyByDay(db, member, addDays(today, -USUAL_WEEKS * 7), addDays(today, -1));
  const byWeekday = new Map<number, number[]>();
  for (const [date, { minutes }] of days) {
    const dow = Temporal.PlainDate.from(date).dayOfWeek;
    byWeekday.set(dow, [...(byWeekday.get(dow) ?? []), minutes]);
  }
  return new Map([1, 2, 3, 4, 5, 6, 7].map((dow) => [dow, median(byWeekday.get(dow) ?? [])]));
}

/** Whether this person has any calendar counting toward their load. */
export function hasCalendar(db: Db, memberId: string) {
  return !!db
    .select({ id: calendarSources.id })
    .from(calendarSources)
    .where(and(eq(calendarSources.memberId, memberId), eq(calendarSources.counts, true)))
    .get();
}

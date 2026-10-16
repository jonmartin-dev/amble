// The phone's own calendars. The Amble app asks Android for them (android/.../PhoneCalendarPlugin.java)
// and hands them here: first the list, so this copy knows which count, then the events of those,
// for a window around today. They stay on this phone; how busy each day is goes to the household.
import { and, count, eq, gt, gte, notInArray } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { busyDays, calendarEvents, calendars, serverSettings, type Member } from '../db/schema.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import { CALENDAR_WINDOW, shareBusyDays } from './events.ts';
import { DomainError } from './household.ts';

/** A calendar as the phone lists it. */
export interface PhoneCalendar {
  id: string;
  account: string | null;
  name: string;
  color: string | null;
  primary: boolean;
  /** Its owner can change it (their own calendar, or a shared one they help keep), as opposed to a subscription. */
  writable: boolean;
  /** Shown in the phone's calendar app. */
  visible: boolean;
}

/** One occurrence of an event as the phone has it. */
export interface PhoneEvent {
  /** Unique within its calendar: the event and the start of this occurrence. */
  id: string;
  calendarId: string;
  uid: string | null;
  title: string | null;
  /** Milliseconds since 1970. All-day events start and end at midnight UTC. */
  begin: number;
  end: number;
  allDay: boolean;
  busy: boolean;
}

const KEY = 'phone-calendars';
const INSERT_CHUNK = 500;

/** Whether this phone reads its calendars: on once someone allows it, off when they stop. */
export function readsPhoneCalendars(db: Db): boolean {
  const value = db.select().from(serverSettings).where(eq(serverSettings.key, KEY)).get()?.value as { on?: boolean } | undefined;
  return value?.on === true;
}

function setReading(db: Db, on: boolean) {
  const value = { on };
  db.insert(serverSettings).values({ key: KEY, value }).onConflictDoUpdate({ target: serverSettings.key, set: { value } }).run();
}

/**
 * Which calendars count until someone says otherwise. A phone often carries other people's
 * accounts too (a partner's, a work one) and subscriptions like holidays and birthdays, so when
 * one of its accounts is the person's own, only that account's calendars count: their own, and
 * shared ones they help keep. Otherwise just the main calendar does.
 */
function countsByDefault(c: PhoneCalendar, email: string | null) {
  if (!email) return c.primary;
  return c.account?.toLowerCase() === email && (c.primary || (c.writable && c.visible));
}

/** The days events are read for, as moments: midnight at each end, in the person's timezone. */
export function calendarWindow(member: Pick<Member, 'timezone' | 'dayCutoffHour'>) {
  const today = planningDate(member);
  const start = (date: string) => Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: member.timezone }).epochMilliseconds;
  return { from: start(addDays(today, -CALENDAR_WINDOW.past)), to: start(addDays(today, CALENDAR_WINDOW.future + 1)) };
}

/**
 * Takes in the phone's calendar list: new ones count by default if they're the person's own (see
 * countsByDefault), renamed ones keep whether they count, and ones the phone no longer has go with their events.
 * Returns the phone's ids of the ones that count, to read events from, and the window to read.
 */
export function savePhoneCalendars(db: Db, member: Member, list: PhoneCalendar[]) {
  setReading(db, true);
  const own = member.email.toLowerCase();
  const email = list.some((c) => c.account?.toLowerCase() === own) ? own : null;
  const known = new Map(
    db
      .select()
      .from(calendars)
      .where(eq(calendars.memberId, member.id))
      .all()
      .map((c) => [c.calendarId, c]),
  );
  db.transaction(() => {
    for (const c of list) {
      const fields = { account: c.account?.slice(0, 200) ?? null, name: c.name.slice(0, 200) || 'Calendar', color: c.color, primary: c.primary };
      const was = known.get(c.id);
      if (was) db.update(calendars).set(fields).where(eq(calendars.id, was.id)).run();
      else db.insert(calendars).values({ memberId: member.id, calendarId: c.id, counts: countsByDefault(c, email), ...fields }).run();
    }
    const kept = list.map((c) => c.id);
    db.delete(calendars)
      .where(and(eq(calendars.memberId, member.id), kept.length ? notInArray(calendars.calendarId, kept) : undefined))
      .run();
  });
  const counting = db
    .select({ calendarId: calendars.calendarId })
    .from(calendars)
    .where(and(eq(calendars.memberId, member.id), eq(calendars.counts, true)))
    .all()
    .map((c) => c.calendarId);
  return { counting, window: calendarWindow(member) };
}

/** An event as Amble keeps it. All-day ones keep their dates, starting at midnight where the person is. */
function toRow(e: PhoneEvent, calendarRowId: string, member: Member): typeof calendarEvents.$inferInsert | null {
  if (!Number.isFinite(e.begin) || !Number.isFinite(e.end) || e.end < e.begin) return null;
  let startAt = e.begin;
  let endAt = e.end;
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (e.allDay) {
    // Android keeps all-day events at midnight UTC: those are the dates.
    startDate = new Date(e.begin).toISOString().slice(0, 10);
    endDate = new Date(Math.max(e.end, e.begin + 86_400_000)).toISOString().slice(0, 10);
    const midnight = (d: string) => Temporal.PlainDate.from(d).toZonedDateTime({ timeZone: member.timezone }).epochMilliseconds;
    startAt = midnight(startDate);
    endAt = midnight(endDate);
  }
  return {
    calendarId: calendarRowId,
    memberId: member.id,
    eventId: e.id.slice(0, 200),
    uid: e.uid?.slice(0, 300) || null,
    title: e.title?.trim().slice(0, 300) || null,
    allDay: e.allDay,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    startDate,
    endDate,
    busy: e.busy,
  };
}

/**
 * Takes in the events of the calendars that count, for the whole window: whatever was there before
 * goes, so a moved or cancelled event doesn't linger. Then the household hears how busy each day is.
 */
export function savePhoneEvents(db: Db, member: Member, events: PhoneEvent[]) {
  const counting = db
    .select()
    .from(calendars)
    .where(and(eq(calendars.memberId, member.id), eq(calendars.counts, true)))
    .all();
  const byPhoneId = new Map(counting.map((c) => [c.calendarId, c.id]));
  const rows = events.flatMap((e) => {
    const id = byPhoneId.get(e.calendarId);
    const row = id ? toRow(e, id, member) : null;
    return row ? [row] : [];
  });
  db.transaction(() => {
    db.delete(calendarEvents).where(eq(calendarEvents.memberId, member.id)).run();
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) db.insert(calendarEvents).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoNothing().run();
  });
  shareBusyDays(db, member);
  return rows.length;
}

/** Whether a calendar counts. Turning one off drops its events; the app reads them again when it's turned on. */
export function setCalendarCounts(db: Db, member: Member, id: string, counts: boolean) {
  const row = db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, id), eq(calendars.memberId, member.id)))
    .get();
  if (!row) throw new DomainError('No such calendar.');
  db.update(calendars).set({ counts }).where(eq(calendars.id, row.id)).run();
  if (!counts) {
    db.delete(calendarEvents).where(eq(calendarEvents.calendarId, row.id)).run();
    shareBusyDays(db, member);
  }
}

/** Stops reading this phone's calendars: they and their events go, and the household's busy days with them. */
export function stopPhoneCalendars(db: Db, member: Member) {
  setReading(db, false);
  db.delete(calendars).where(eq(calendars.memberId, member.id)).run();
  shareBusyDays(db, member);
}

/** The Calendars page: this phone's calendars by account, and whether it reads them. */
export function listPhoneCalendars(db: Db, member: Member) {
  const rows = db.select().from(calendars).where(eq(calendars.memberId, member.id)).all();
  return {
    on: readsPhoneCalendars(db),
    calendars: rows
      .sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, account: c.account, name: c.name, color: c.color, primary: c.primary, counts: c.counts })),
  };
}

/** Days from today on that someone's phone has shared as busy: for the Calendars page where there's no phone calendar. */
export function sharedBusyDays(db: Db, member: Member) {
  return db
    .select({ n: count() })
    .from(busyDays)
    .where(and(eq(busyDays.memberId, member.id), gte(busyDays.date, planningDate(member)), gt(busyDays.minutes, 0)))
    .get()!.n;
}

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.ts';
import { activity, busyDays, calendarEvents, members, tasks, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import { startCapture, stamp } from '../sync/capture.ts';
import { Clock } from '../sync/hlc.ts';
import { exportState, mergeState } from '../sync/state.ts';
import { listPhoneCalendars, readsPhoneCalendars, savePhoneCalendars, savePhoneEvents, setCalendarCounts, sharedBusyDays, stopPhoneCalendars, type PhoneCalendar, type PhoneEvent } from './calendars.ts';
import { busyByDay, listEvents, usualBusy } from './events.ts';
import { getLoad, learnedCapacity, roomAfterEvents } from './load.ts';

const TZ = 'America/Chicago';

/** A local time on a date in Chicago, as the phone gives it: milliseconds. */
const at = (date: string, time: string) => Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(TZ).epochMilliseconds;

function timed(id: string, date: string, from: string, to: string, extra: Partial<PhoneEvent> = {}): PhoneEvent {
  return { id, calendarId: '1', uid: `${id}@example.com`, title: id, begin: at(date, from), end: at(date, to), allDay: false, busy: true, ...extra };
}

/** Android keeps all-day events at midnight UTC. */
function allDay(id: string, date: string, days: number, extra: Partial<PhoneEvent> = {}): PhoneEvent {
  return { id, calendarId: '1', uid: null, title: id, begin: Date.parse(`${date}T00:00:00Z`), end: Date.parse(`${addDays(date, days)}T00:00:00Z`), allDay: true, busy: true, ...extra };
}

const PHONE: PhoneCalendar[] = [
  { id: '1', account: 'jon@example.com', name: 'Jon', color: '#33aa66', primary: true, writable: true, visible: true },
  { id: '2', account: 'jon@example.com', name: 'Family', color: null, primary: false, writable: true, visible: true },
  { id: '3', account: 'jon@example.com', name: 'Holidays in United States', color: null, primary: false, writable: false, visible: true },
  { id: '4', account: 'Samsung account', name: 'Old work', color: null, primary: false, writable: true, visible: false },
];

let db: Db;
let jon: Member;
let today: string;

/** What the app does when it opens: hands over the list, then the events of the ones that count. */
function readPhone(events: PhoneEvent[], list = PHONE) {
  const { counting } = savePhoneCalendars(db, jon, list);
  return savePhoneEvents(
    db,
    jon,
    events.filter((e) => counting.includes(e.calendarId)),
  );
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: TZ, role: 'admin' }).returning().get();
  today = planningDate(jon);
});

describe("the phone's calendars", () => {
  it("counts your own calendars and shared ones you help keep, not subscriptions, hidden ones or other people's, and remembers changes", () => {
    expect(readsPhoneCalendars(db)).toBe(false);
    const { counting, window } = savePhoneCalendars(db, jon, PHONE);
    expect(readsPhoneCalendars(db)).toBe(true);
    expect(counting.sort()).toEqual(['1', '2']);
    // Someone else's account on the same phone doesn't count, even calendars they can change.
    savePhoneCalendars(db, jon, [...PHONE, { id: '5', account: 'ali@example.com', name: 'Ali', color: null, primary: true, writable: true, visible: true }]);
    expect(listPhoneCalendars(db, jon).calendars.find((c) => c.name === 'Ali')).toMatchObject({ counts: false });
    expect(window.to - window.from).toBeGreaterThan(260 * 86_400_000);

    const family = listPhoneCalendars(db, jon).calendars.find((c) => c.name === 'Family')!;
    setCalendarCounts(db, jon, family.id, false);
    // Renamed on the phone, and one calendar gone: the choice stays, the missing one goes.
    savePhoneCalendars(db, jon, [PHONE[0]!, { ...PHONE[1]!, name: 'The family' }, PHONE[2]!]);
    expect(listPhoneCalendars(db, jon).calendars.map((c) => [c.account, c.name, c.counts])).toEqual([
      ['jon@example.com', 'Jon', true],
      ['jon@example.com', 'Holidays in United States', false],
      ['jon@example.com', 'The family', false],
    ]);
    expect(() => setCalendarCounts(db, jon, 'nope', true)).toThrow('No such calendar.');
  });

  it("counts just the main calendar on a phone that doesn't have the person's own account", () => {
    const { counting } = savePhoneCalendars(
      db,
      jon,
      PHONE.map((c) => ({ ...c, account: c.account === 'jon@example.com' ? 'jon.work@example.com' : c.account })),
    );
    expect(counting).toEqual(['1']);
  });

  it('keeps the events of calendars that count, all-day ones on their own dates, and shows a shared meeting once', () => {
    readPhone([
      timed('dentist', today, '09:00', '10:00'),
      timed('dentist-family', today, '09:00', '10:00', { calendarId: '2', uid: 'dentist@example.com' }),
      allDay('birthday', addDays(today, 1), 1, { calendarId: '2', busy: false }),
      timed('holiday thing', today, '12:00', '13:00', { calendarId: '3' }),
    ]);
    expect(listEvents(db, jon, today, today).map((e) => [e.title, e.calendar])).toEqual([['dentist', 'Jon']]);
    const [birthday] = listEvents(db, jon, addDays(today, 1), addDays(today, 1));
    expect(birthday).toMatchObject({ title: 'birthday', allDay: true, startDate: addDays(today, 1), endDate: addDays(today, 2), busy: false });
    // Midnight where Jon is, not in UTC.
    expect(birthday!.start).toBe(new Date(at(addDays(today, 1), '00:00')).toISOString());
  });

  it("forgets what's gone on the next read, and a calendar's events when it stops counting", () => {
    readPhone([timed('standup', today, '09:00', '09:15'), timed('soccer', today, '17:00', '18:00', { calendarId: '2' })]);
    readPhone([timed('standup', today, '09:30', '09:45'), timed('soccer', today, '17:00', '18:00', { calendarId: '2' })]);
    expect(listEvents(db, jon, today, today).map((e) => e.title)).toEqual(['standup', 'soccer']);
    expect(listEvents(db, jon, today, today)[0]!.start).toBe(new Date(at(today, '09:30')).toISOString());

    const family = listPhoneCalendars(db, jon).calendars.find((c) => c.name === 'Family')!;
    setCalendarCounts(db, jon, family.id, false);
    expect(listEvents(db, jon, today, today).map((e) => e.title)).toEqual(['standup']);
    expect(busyByDay(db, jon, today, today).get(today)).toEqual({ minutes: 15, events: 1 });
  });

  it('stops: calendars, events and the busy days they shared go', () => {
    readPhone([timed('dentist', today, '09:00', '10:00')]);
    expect(sharedBusyDays(db, jon)).toBe(1);
    stopPhoneCalendars(db, jon);
    expect(readsPhoneCalendars(db)).toBe(false);
    expect(listPhoneCalendars(db, jon).calendars).toEqual([]);
    expect(db.select().from(calendarEvents).all()).toEqual([]);
    expect(db.select().from(busyDays).where(eq(busyDays.date, today)).get()).toMatchObject({ minutes: 0, events: 0 });
    expect(busyByDay(db, jon, today, today).get(today)).toEqual({ minutes: 0, events: 0 });
  });
});

describe('busy time', () => {
  it('counts overlapping events once, within waking hours, and fills the day for an all-day busy event', () => {
    const d = addDays(today, 1);
    const trip = addDays(today, 2);
    readPhone([
      timed('a', d, '09:00', '10:30'),
      timed('b', d, '10:00', '11:00', { calendarId: '2' }),
      timed('early', d, '05:00', '08:00'),
      timed('free', d, '13:00', '15:00', { busy: false }),
      allDay('trip', trip, 2),
    ]);
    const busy = busyByDay(db, jon, d, addDays(today, 4));
    // 9:00-11:00 merged is 120, plus 7:00-8:00 of the early one.
    expect(busy.get(d)).toEqual({ minutes: 180, events: 3 });
    expect(busy.get(trip)).toEqual({ minutes: 900, events: 1 });
    expect(busy.get(addDays(trip, 1))).toEqual({ minutes: 900, events: 1 });
    expect(busy.get(addDays(today, 4))).toEqual({ minutes: 0, events: 0 });
  });

  it('shares only how busy each day is, and only the days that changed', () => {
    readPhone([timed('dentist', today, '09:00', '10:00'), timed('lunch', addDays(today, 3), '12:00', '13:00')]);
    const shared = db.select().from(busyDays).where(eq(busyDays.memberId, jon.id)).all();
    expect(shared.map((d) => [d.date, d.minutes, d.events])).toEqual([
      [today, 60, 1],
      [addDays(today, 3), 60, 1],
    ]);
    // Nothing about what the events are.
    expect(Object.keys(shared[0]!).sort()).toEqual(['date', 'events', 'memberId', 'minutes']);

    startCapture(db);
    stamp(db, new Clock('phone001'));
    readPhone([timed('dentist', today, '09:00', '10:00'), timed('lunch', addDays(today, 3), '12:00', '14:00')]);
    const changed = db.$client.prepare(`SELECT pk, col FROM sync_cells WHERE tbl = 'busy_days' AND hlc IS NULL`).all();
    expect(changed).toEqual([{ pk: JSON.stringify([jon.id, addDays(today, 3)]), col: 'minutes' }]);
  });
});

describe('load with a calendar', () => {
  it('shrinks the day with its free time compared with a usual one, and leaves a standing weekly meeting alone', () => {
    // A two-hour meeting on this weekday every week for eight weeks is usual; a three-hour party tomorrow is not.
    const events = [];
    for (let w = 0; w <= 8; w++) events.push(timed(`weekly-${w}`, addDays(today, 7 * (1 - w)), '13:00', '15:00'));
    events.push(timed('party', addDays(today, 1), '17:00', '20:00'));
    readPhone(events);
    expect(usualBusy(db, jon, today).get(Temporal.PlainDate.from(today).dayOfWeek)).toBe(120);

    const [day, tomorrow] = getLoad(db, jon, jon, today, addDays(today, 1));
    expect(day).toMatchObject({ eventMinutes: 120, usualEventMinutes: 120, capacityMinutes: day!.baseCapacityMinutes });
    expect(tomorrow).toMatchObject({ eventMinutes: 180, usualEventMinutes: 0, events: 1 });
    // 720 of a usual 900 free waking minutes: four fifths of the room.
    expect(tomorrow!.capacityMinutes).toBe(Math.round((tomorrow!.baseCapacityMinutes * 0.8) / 5) * 5);
  });

  it('gives a lighter-than-usual day more room, up to half again, and a day off stays off', () => {
    expect(roomAfterEvents(180, 0, 120)).toBe(210);
    expect(roomAfterEvents(180, 210, 30)).toBe(145);
    expect(roomAfterEvents(180, 0, 900)).toBe(270);
    expect(roomAfterEvents(180, 900, 0)).toBe(0);
    expect(roomAfterEvents(0, 0, 300)).toBe(0);
  });

  it('learns capacity as if busy days had been ordinary ones', () => {
    // Jon finished 120 minutes on each of the last six of this weekday, and two of those days also
    // had a four-hour event on top of a usually empty calendar.
    const dow = Temporal.PlainDate.from(today).dayOfWeek;
    for (let w = 1; w <= 6; w++) {
      const date = addDays(today, -7 * w);
      const when = new Date(at(date, '12:00'));
      db.insert(tasks).values({ title: `t${w}`, status: 'done', completedAt: when, completedById: jon.id, estimateMinutes: 120, updatedAt: when }).run();
      db.insert(activity).values({ memberId: jon.id, action: 'task.completed', createdAt: when }).run();
    }
    expect(learnedCapacity(db, jon).find((d) => d.weekday === dow)!.minutes).toBe(120);
    readPhone([timed('conference', addDays(today, -7), '09:00', '13:00'), timed('workshop', addDays(today, -14), '09:00', '13:00')]);
    // Those two had 660 free waking minutes instead of 900, so their 120 counts as about 164, and a
    // good day is the 75th percentile of 120, 120, 120, 120, 164, 164.
    expect(learnedCapacity(db, jon).find((d) => d.weekday === dow)!.minutes).toBe(150);
  });

  it("counts on every other copy from the busy days the phone shared, with none of the events", () => {
    startCapture(db);
    const phoneClock = new Clock('phone001');
    readPhone([timed('party', addDays(today, 1), '17:00', '20:00')]);
    stamp(db, phoneClock);

    // The household's server, or someone's browser: a copy with no calendars of its own.
    const other = openDatabase(':memory:');
    startCapture(other);
    const otherClock = new Clock('server01');
    mergeState(other, otherClock, exportState(db, phoneClock, 'test'), 'test');
    const there = other.select().from(members).where(eq(members.id, jon.id)).get()!;
    expect(listEvents(other, there, today, addDays(today, 1))).toEqual([]);
    const [, tomorrow] = getLoad(other, there, there, today, addDays(today, 1));
    const [, onPhone] = getLoad(db, jon, jon, today, addDays(today, 1));
    expect(tomorrow).toMatchObject({ eventMinutes: 180, events: 1, capacityMinutes: onPhone!.capacityMinutes });
  });
});

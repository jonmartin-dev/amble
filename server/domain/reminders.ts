// Reminders: one notification about a task, at a time someone chose. They're personal: only the
// person who set one sees it on the task or gets the notification. Nothing in Almanac sets one on
// its own.
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { members, reminders, tasks, type Member } from '../db/schema.ts';
import { DomainError } from './household.ts';
import { reminderId } from '../lib/ids.ts';

export interface ReminderView {
  id: string;
  at: Date;
  /** When it went out; null while it's still to come. */
  sentAt: Date | null;
}

const MAX_AHEAD_MS = 2 * 366 * 24 * 60 * 60 * 1000;
// A picker rounds to the minute and a phone's clock can be a little off, so "now" counts.
const GRACE_MS = 2 * 60 * 1000;

/** Each task's reminder for one person. */
export function remindersFor(db: Db, memberId: string, taskIds: string[]): Map<string, ReminderView> {
  if (taskIds.length === 0) return new Map();
  const rows = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.memberId, memberId), inArray(reminders.taskId, taskIds)))
    .all();
  return new Map(rows.map((r) => [r.taskId, { id: r.id, at: r.fireAt, sentAt: r.sentAt }]));
}

/**
 * Sets or moves a person's reminder on a task, or clears it with null. A change the app sends
 * late (made offline) may name a time that has passed by now; it goes out straight away.
 */
export function setReminder(db: Db, member: Member, taskId: string, at: Date | null, late = false) {
  if (at === null) {
    db.delete(reminders).where(and(eq(reminders.taskId, taskId), eq(reminders.memberId, member.id))).run();
    return;
  }
  if (Number.isNaN(at.getTime())) throw new DomainError("That isn't a time.");
  const now = Date.now();
  if (!late && at.getTime() < now - GRACE_MS) throw new DomainError('That time has already passed. Pick a later one.');
  if (at.getTime() > now + MAX_AHEAD_MS) throw new DomainError('A reminder can be at most two years ahead.');
  db.insert(reminders)
    .values({ id: reminderId(taskId, member.id), taskId, memberId: member.id, fireAt: at })
    .onConflictDoUpdate({ target: [reminders.taskId, reminders.memberId], set: { fireAt: at, sentAt: null, outcome: null } })
    .run();
}

/** Puts a reminder off for a while; it goes out again then. Returns its task. */
export function snoozeReminder(db: Db, member: Member, id: string, minutes: number) {
  const row = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.memberId, member.id)))
    .get();
  if (!row) throw new DomainError('That reminder is gone.');
  db.update(reminders)
    .set({ fireAt: new Date(Date.now() + minutes * 60_000), sentAt: null, outcome: null })
    .where(eq(reminders.id, id))
    .run();
  return row.taskId;
}

/** A person's reminders still to come, soonest first, on tasks that are still open. */
export function upcomingReminders(db: Db, member: Member) {
  return db
    .select({ id: reminders.id, taskId: tasks.id, title: tasks.title, at: reminders.fireAt })
    .from(reminders)
    .innerJoin(tasks, eq(reminders.taskId, tasks.id))
    .where(and(eq(reminders.memberId, member.id), isNull(reminders.sentAt), eq(tasks.status, 'open')))
    .orderBy(asc(reminders.fireAt))
    .all();
}

/** Reminders whose time has come and that haven't gone out. */
export function dueReminders(db: Db, now = new Date()) {
  return db
    .select({ reminder: reminders, task: tasks, member: members })
    .from(reminders)
    .innerJoin(tasks, eq(reminders.taskId, tasks.id))
    .innerJoin(members, eq(reminders.memberId, members.id))
    .where(and(isNull(reminders.sentAt), lte(reminders.fireAt, now)))
    .orderBy(asc(reminders.fireAt))
    .all();
}

export function markReminder(db: Db, id: string, outcome: 'sent' | 'no-device' | 'skipped' | 'failed') {
  db.update(reminders).set({ sentAt: new Date(), outcome }).where(eq(reminders.id, id)).run();
}

/** The same wall-clock time, some days later, in the person's timezone (so 6pm stays 6pm across a clock change). */
function laterBy(at: Date, days: number, timeZone: string) {
  return new Date(Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timeZone).add({ days }).epochMilliseconds);
}

function withZones(db: Db, taskId: string) {
  return db
    .select({ reminder: reminders, timezone: members.timezone })
    .from(reminders)
    .innerJoin(members, eq(reminders.memberId, members.id))
    .where(eq(reminders.taskId, taskId))
    .all();
}

/**
 * A repeating task's next one gets the reminders the last one had, as many days on as the task
 * moved: "the evening before bin day" stays the evening before.
 */
export function carryReminders(db: Db, fromTaskId: string, toTaskId: string, days: number) {
  const now = Date.now();
  for (const { reminder, timezone } of withZones(db, fromTaskId)) {
    const at = laterBy(reminder.fireAt, days, timezone);
    if (at.getTime() <= now) continue;
    db.insert(reminders).values({ id: reminderId(toTaskId, reminder.memberId), taskId: toTaskId, memberId: reminder.memberId, fireAt: at }).onConflictDoNothing().run();
  }
}

/** Skipping a repeating task moves its reminders with it, ready to go out again. */
export function shiftReminders(db: Db, taskId: string, days: number) {
  const now = Date.now();
  for (const { reminder, timezone } of withZones(db, taskId)) {
    const at = laterBy(reminder.fireAt, days, timezone);
    if (at.getTime() <= now) continue;
    db.update(reminders).set({ fireAt: at, sentAt: null, outcome: null }).where(eq(reminders.id, reminder.id)).run();
  }
}

/**
 * Reads a time the way Claude or smart add gives it: "2026-10-16T18:00" in the person's
 * timezone, or a full ISO time with an offset.
 */
export function parseReminderTime(value: string, timeZone: string): Date {
  const v = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) throw new DomainError(`"${value}" needs a date and a time, like 2026-10-16T18:00.`);
  try {
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) return new Date(Temporal.Instant.from(v).epochMilliseconds);
    return new Date(Temporal.PlainDateTime.from(v).toZonedDateTime(timeZone).epochMilliseconds);
  } catch {
    throw new DomainError(`"${value}" isn't a time. Use YYYY-MM-DDTHH:MM, like 2026-10-16T18:00.`);
  }
}

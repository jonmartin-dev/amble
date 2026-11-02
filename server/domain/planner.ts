// The planning engine: deterministic scores and rules that pick what to suggest and where things
// fit, with plain reasons. The model can reword the reasons (server/ai/plan.ts), but the choices stay
// here, so they're explainable and testable.
import { and, eq, gt, ne } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { activity, dayRecords, members, tasks, type DayRecord, type Member, type StoredSuggestion } from '../db/schema.ts';
import { addDays, daysBetween, planningDate, planningDayStart, weekday } from '../lib/dates.ts';
import { listEvents, type EventView } from './events.ts';
import { DomainError, firstName } from './household.ts';
import { DAY_FILL, DEFAULT_ESTIMATE_MINUTES, getLoad, loadLevel, outlooks, type DayLoad } from './load.ts';
import { getTask, listTasks, type TaskDetail } from './tasks.ts';

const SUGGESTIONS = 3;
// A task this short is a quick one.
const QUICK_MINUTES = 15;
const PLAN_DAYS = 7;
const PLAN_MAX = 20;
const GAP_HORIZON_DAYS = 30;

export type Why = 'overdue' | 'due' | 'must' | 'waiting';

export interface Suggestion {
  task: TaskDetail;
  reason: string;
  why: Why;
  /** Whether it fits in the room the day has left. Urgent ones are suggested even when it doesn't. */
  fits: boolean;
}

const minutesOf = (t: Pick<TaskDetail, 'estimateMinutes'>) => t.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES;

/** How pressing a backlog task is today: due pressure first, then must-do, then how long it's waited. */
export function score(t: Pick<TaskDetail, 'dueDate' | 'mustDo' | 'createdAt'>, today: string, createdOn: string) {
  let s = 0;
  if (t.dueDate) {
    const d = daysBetween(today, t.dueDate);
    if (d < 0) s += 100 + Math.min(-d, 14);
    else if (d === 0) s += 90;
    else if (d === 1) s += 70;
    else if (d <= 3) s += 55 - 5 * (d - 2);
    else if (d <= 7) s += 35 - 2 * (d - 4);
    else if (d <= 14) s += 15;
  }
  if (t.mustDo) s += 40;
  s += Math.min(Math.max(daysBetween(createdOn, today), 0) / 7, 4) * 5;
  return s;
}

function why(t: Pick<TaskDetail, 'dueDate' | 'mustDo'>, today: string): Why {
  if (t.dueDate && t.dueDate < today) return 'overdue';
  if (t.dueDate && daysBetween(today, t.dueDate) <= 14) return 'due';
  if (t.mustDo) return 'must';
  return 'waiting';
}

/** "Sat", or "Sat the 24th" when it's more than a week away. */
function dayName(date: string, today: string) {
  const d = daysBetween(today, date);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  const day = Temporal.PlainDate.from(date);
  const name = day.toLocaleString('en-US', { weekday: 'long' });
  return Math.abs(d) < 7 ? name : `${name} the ${ordinal(day.day)}`;
}

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

function listOf(words: string[]) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function waited(createdOn: string, today: string) {
  const days = daysBetween(createdOn, today);
  if (days >= 14) return `It's been waiting ${Math.floor(days / 7)} weeks`;
  if (days >= 7) return "It's been waiting over a week";
  return null;
}

/** Why a task is worth doing today, in a sentence or two, from the numbers. */
function reasonFor(t: TaskDetail, today: string, createdOn: string, ahead: DayLoad[], room: number): string {
  const parts: string[] = [];
  if (t.dueDate && t.dueDate < today) parts.push(`It was due ${dayName(t.dueDate, today)}.`);
  else if (t.dueDate === today) parts.push('It\'s due today.');
  else if (t.dueDate && daysBetween(today, t.dueDate) <= 14) {
    const before = ahead.filter((d) => d.date <= t.dueDate!);
    const heavy = before.filter((d) => d.level === 'full' || d.level === 'over');
    if (heavy.length) parts.push(`Due ${dayName(t.dueDate, today)}, and ${listOf(heavy.map((d) => dayName(d.date, today)))} ${heavy.length === 1 ? 'looks' : 'look'} full.`);
    else parts.push(`Due ${dayName(t.dueDate, today)}.`);
  } else if (t.mustDo) parts.push('Marked must-do.');
  const wait = waited(createdOn, today);
  if (wait && parts.length === 0) parts.push(`${wait}.`);
  const minutes = minutesOf(t);
  if (minutes <= room && room > 0 && parts.length < 2) parts.push(minutes <= QUICK_MINUTES ? 'A quick one.' : `It fits in the time today has left.`);
  return parts.join(' ') || 'There\'s room for it today.';
}

/** Backlog tasks someone could pick up: open, not on a day, theirs or shared. */
function backlogFor(db: Db, me: Member) {
  return listTasks(db, me, { status: 'open', unplanned: true, assignee: { memberId: me.id, includeShared: true } });
}

/** Due today or before: it's suggested whether or not it fits. */
const dueBy = (t: Pick<TaskDetail, 'dueDate'>, today: string) => !!t.dueDate && t.dueDate <= today;

/**
 * The few backlog tasks most worth pulling into today, best first. Each must fit in the room the
 * day has left, except overdue or due-today ones, which are suggested regardless. People lean to
 * urgent over important and to easy over hard, so the last pick goes to something that matters
 * but isn't due (a must-do, or what's waited longest) when nothing before it does, and isn't a
 * third quick one. On a day they said was rough, only must-dos and what's due today come up.
 */
export function suggestForDay(db: Db, me: Member, { exclude = new Set<string>(), limit = SUGGESTIONS } = {}): Suggestion[] {
  const today = planningDate(me);
  const rough = outlooks(db, me.id, today, today).get(today) === 'rough';
  const [todayLoad, ...ahead] = getLoad(db, me, me, today, addDays(today, 14));
  let room = todayLoad!.capacityMinutes - todayLoad!.plannedMinutes;
  const left = backlogFor(db, me)
    .filter((t) => !exclude.has(t.id) && (!rough || t.mustDo || dueBy(t, today)))
    .map((t) => {
      const createdOn = planningDate(me, Temporal.Instant.fromEpochMilliseconds(t.createdAt.getTime()));
      return { t, createdOn, score: score(t, today, createdOn) };
    })
    // A new task with no date or flag isn't pressing yet.
    .filter((s) => s.score >= 5)
    .sort((a, b) => b.score - a.score || a.t.createdAt.getTime() - b.t.createdAt.getTime());
  const picked: Suggestion[] = [];
  while (picked.length < limit) {
    const can = left.filter(({ t }) => minutesOf(t) <= room || dueBy(t, today));
    let next = can[0];
    if (!next) break;
    if (limit > 1 && picked.length === limit - 1 && !dueBy(next.t, today)) {
      const needImportant = !picked.some((p) => p.why === 'must' || p.why === 'waiting');
      const needBigger = picked.every((p) => minutesOf(p.task) <= QUICK_MINUTES);
      const important = (s: (typeof can)[number]) => !needImportant || ['must', 'waiting'].includes(why(s.t, today));
      const bigger = (s: (typeof can)[number]) => !needBigger || minutesOf(s.t) > QUICK_MINUTES;
      next = can.find((s) => important(s) && bigger(s)) ?? can.find(important) ?? can.find(bigger) ?? next;
    }
    left.splice(left.indexOf(next), 1);
    const minutes = minutesOf(next.t);
    picked.push({ task: next.t, reason: reasonFor(next.t, today, next.createdOn, ahead, room), why: why(next.t, today), fits: minutes <= room });
    room -= minutes;
  }
  return picked;
}

// ---- the morning briefing ---------------------------------------------------------------------

export interface HandedOver {
  task: TaskDetail;
  from: string;
  note: string | null;
}

export interface Briefing {
  date: string;
  seen: boolean;
  greeting: string;
  load: DayLoad;
  events: EventView[];
  /** Tasks someone else gave you since yesterday. */
  handedOver: HandedOver[];
  /** Planned before today and still open. */
  carriedOver: TaskDetail[];
  suggestions: Suggestion[];
  /** How they said today was looking; null is a normal day. */
  outlook: DayRecord['outlook'];
  /** On today with no deadline and not must-do: what can wait if the day goes sideways. */
  canWait: TaskDetail[];
}

export function dayRecord(db: Db, memberId: string, date: string): DayRecord {
  db.insert(dayRecords).values({ memberId, date }).onConflictDoNothing().run();
  return db.select().from(dayRecords).where(and(eq(dayRecords.memberId, memberId), eq(dayRecords.date, date))).get()!;
}

function greeting(me: Member) {
  const hour = Temporal.Now.zonedDateTimeISO(me.timezone).hour;
  const part = hour >= 4 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${firstName(me)}`;
}

/** What someone else handed you since the start of yesterday's planning day, newest first. */
function handedOver(db: Db, me: Member, today: string): HandedOver[] {
  const since = planningDayStart(me, addDays(today, -1));
  const names = new Map(db.select({ id: members.id, name: members.name }).from(members).all().map((m) => [m.id, m.name]));
  const found = new Map<string, { from: string; note: string | null; at: number }>();
  const assigned = db
    .select({ taskId: activity.taskId, memberId: activity.memberId, detail: activity.detail, at: activity.createdAt })
    .from(activity)
    .where(and(eq(activity.action, 'task.assigned'), gt(activity.createdAt, since), ne(activity.memberId, me.id)))
    .all();
  for (const a of assigned) {
    const detail = a.detail as { to?: string | null; note?: string | null } | null;
    if (!a.taskId || detail?.to !== me.id) continue;
    found.set(a.taskId, { from: names.get(a.memberId ?? '') ?? 'Someone', note: detail.note ?? null, at: a.at.getTime() });
  }
  const created = db
    .select({ id: tasks.id, by: tasks.createdById, at: tasks.createdAt })
    .from(tasks)
    .where(and(eq(tasks.assigneeId, me.id), ne(tasks.createdById, me.id), gt(tasks.createdAt, since), eq(tasks.status, 'open')))
    .all();
  for (const t of created) if (!found.has(t.id)) found.set(t.id, { from: names.get(t.by ?? '') ?? 'Someone', note: null, at: t.at.getTime() });
  const out: (HandedOver & { at: number })[] = [];
  for (const [taskId, h] of found) {
    try {
      const task = getTask(db, me, taskId);
      if (task.status === 'open' && task.assigneeId === me.id) out.push({ task, from: firstName({ name: h.from }), note: h.note, at: h.at });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
    }
  }
  return out.sort((a, b) => b.at - a.at).map(({ at: _at, ...h }) => h);
}

/**
 * The day's suggestions, using reasons saved earlier (the model's, from the morning) where a task is
 * still suggested; anything new gets the built-in wording.
 */
export function daySuggestions(db: Db, me: Member, record = dayRecord(db, me.id, planningDate(me))): Suggestion[] {
  const saved = new Map((record.suggestions ?? []).map((s) => [s.taskId, s.reason]));
  return suggestForDay(db, me, { exclude: new Set(record.dismissed) }).map((s) => ({ ...s, reason: saved.get(s.task.id) ?? s.reason }));
}

export function getBriefing(db: Db, me: Member): Briefing {
  const today = planningDate(me);
  const record = dayRecord(db, me.id, today);
  const [load] = getLoad(db, me, me, today, today);
  const planned = listTasks(db, me, { plannedOn: today, assignee: { memberId: me.id, includeShared: true } });
  return {
    date: today,
    seen: record.briefingSeenAt != null,
    greeting: greeting(me),
    load: load!,
    events: listEvents(db, me, today, today),
    handedOver: handedOver(db, me, today),
    carriedOver: listTasks(db, me, { plannedBefore: today, assignee: { memberId: me.id, includeShared: true } }),
    suggestions: daySuggestions(db, me, record),
    outlook: record.outlook,
    canWait: planned.filter((t) => !t.dueDate && !t.mustDo),
  };
}

/** How today is looking, which gives it less room or more. Null is a normal day. */
export function setOutlook(db: Db, me: Member, outlook: DayRecord['outlook']) {
  const today = planningDate(me);
  dayRecord(db, me.id, today);
  db.update(dayRecords)
    .set({ outlook })
    .where(and(eq(dayRecords.memberId, me.id), eq(dayRecords.date, today)))
    .run();
}

export function markBriefingSeen(db: Db, me: Member) {
  const today = planningDate(me);
  dayRecord(db, me.id, today);
  db.update(dayRecords)
    .set({ briefingSeenAt: new Date() })
    .where(and(eq(dayRecords.memberId, me.id), eq(dayRecords.date, today)))
    .run();
}

/** "Later": not suggested again today. */
export function dismissSuggestion(db: Db, me: Member, taskId: string) {
  const today = planningDate(me);
  const record = dayRecord(db, me.id, today);
  if (record.dismissed.includes(taskId)) return;
  db.update(dayRecords)
    .set({ dismissed: [...record.dismissed, taskId] })
    .where(and(eq(dayRecords.memberId, me.id), eq(dayRecords.date, today)))
    .run();
}

export function saveReasons(db: Db, me: Member, date: string, suggestions: StoredSuggestion[], by: 'template' | 'ai') {
  dayRecord(db, me.id, date);
  db.update(dayRecords)
    .set({ suggestions, reasonsBy: by })
    .where(and(eq(dayRecords.memberId, me.id), eq(dayRecords.date, date)))
    .run();
}

// ---- finding a day ------------------------------------------------------------------------------

export interface DayPick {
  task: TaskDetail;
  date: string;
  weekday: string;
  /** False when every day up to the deadline is already full and this is just the lightest. */
  fits: boolean;
  reason: string;
}

type Slot = DayLoad & { added: number };

/** The day in `days` with the most room after adding `minutes`; ties go to the earlier day, and a day it fits wins over one it doesn't. */
function lightest(days: Slot[], minutes: number, fill = 1) {
  const ranked = days
    .map((d) => {
      const after = d.plannedMinutes + d.added + minutes;
      const cap = d.capacityMinutes * fill;
      return { d, fits: after <= cap, score: d.capacityMinutes ? Math.round((after / d.capacityMinutes) * 20) : Infinity };
    })
    .sort((a, b) => Number(b.fits) - Number(a.fits) || a.score - b.score || (a.d.date < b.d.date ? -1 : 1));
  return ranked[0];
}

/**
 * A day for each unplanned task with a deadline in the next month, earliest deadline first. Each
 * pick counts toward the next, so two tasks don't both land on the one light day.
 */
export function findGaps(db: Db, me: Member): DayPick[] {
  const today = planningDate(me);
  const end = addDays(today, GAP_HORIZON_DAYS);
  const due = backlogFor(db, me)
    .filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= end)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : Number(b.mustDo) - Number(a.mustDo)));
  if (due.length === 0) return [];
  const last = due.at(-1)!.dueDate!;
  const days: Slot[] = getLoad(db, me, me, today, last).map((d) => ({ ...d, added: 0 }));
  return due.map((t) => {
    const minutes = minutesOf(t);
    const pick = lightest(days.filter((d) => d.date <= t.dueDate!), minutes)!;
    pick.d.added += minutes;
    const when = dayName(pick.d.date, today);
    const reason = pick.fits
      ? pick.d.date === t.dueDate
        ? `${capital(when)} still has room, and it's due then.`
        : `${capital(when)} has the most room before it's due ${dayName(t.dueDate!, today)}.`
      : `Every day until it's due is full; ${when} is the lightest.`;
    return { task: t, date: pick.d.date, weekday: weekday(pick.d.date), fits: pick.fits, reason };
  });
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- plan my week -------------------------------------------------------------------------------

export interface WeekPlan {
  start: string;
  days: DayLoad[];
  picks: DayPick[];
}

/**
 * A plan for the next seven days: the most pressing backlog tasks, and anything left over from
 * earlier days, each on the day with the most room. Days fill only as full as the person likes
 * them (85% to start), so there's slack. Deadlines are kept; tasks without one only go where
 * there's room, and the rest stay in the backlog.
 */
export function planWeek(db: Db, me: Member): WeekPlan {
  const today = planningDate(me);
  const end = addDays(today, PLAN_DAYS - 1);
  const fill = DAY_FILL[me.dayFill].plan;
  const loads = getLoad(db, me, me, today, end);
  const days: Slot[] = loads.map((d) => ({ ...d, added: 0 }));
  const leftOver = listTasks(db, me, { plannedBefore: today, assignee: { memberId: me.id, includeShared: true } });
  const candidates = [...leftOver, ...backlogFor(db, me)]
    .map((t) => {
      const createdOn = planningDate(me, Temporal.Instant.fromEpochMilliseconds(t.createdAt.getTime()));
      // Left over from an earlier day counts like being overdue: it was meant to be done already.
      const s = score(t, today, createdOn) + (t.plannedDate ? 60 : 0);
      return { t, createdOn, s };
    })
    .sort((a, b) => b.s - a.s || a.t.createdAt.getTime() - b.t.createdAt.getTime());
  const picks: DayPick[] = [];
  for (const { t, createdOn } of candidates) {
    if (picks.length >= PLAN_MAX) break;
    const minutes = minutesOf(t);
    const deadline = t.dueDate && t.dueDate >= today && t.dueDate <= end ? t.dueDate : null;
    const urgent = !!t.plannedDate || (!!t.dueDate && t.dueDate <= end);
    const allowed = deadline ? days.filter((d) => d.date <= deadline) : days;
    const pick = lightest(allowed, minutes, fill);
    if (!pick || (!pick.fits && !urgent)) continue;
    pick.d.added += minutes;
    const when = dayName(pick.d.date, today);
    let reason: string;
    if (t.plannedDate) reason = `Left over from ${dayName(t.plannedDate, today)}; ${when} has room.`;
    else if (t.dueDate && t.dueDate < today) reason = `It was due ${dayName(t.dueDate, today)}; ${when} has the most room.`;
    else if (deadline) reason = pick.fits ? `Due ${dayName(deadline, today)}; ${when} has the most room before then.` : `Due ${dayName(deadline, today)}, and every day before is full; ${when} is the lightest.`;
    else if (t.mustDo) reason = `Must-do, and ${when} has room.`;
    else reason = `${waited(createdOn, today) ?? 'From the backlog'}; ${when} has room.`;
    picks.push({ task: t, date: pick.d.date, weekday: weekday(pick.d.date), fits: pick.fits, reason });
  }
  const after = loads.map((d) => {
    const added = days.find((x) => x.date === d.date)!.added;
    const plannedMinutes = d.plannedMinutes + added;
    return { ...d, plannedMinutes, tasks: d.tasks + picks.filter((p) => p.date === d.date).length, level: loadLevel(plannedMinutes, d.capacityMinutes, d.fullAt) };
  });
  return { start: today, days: after, picks };
}

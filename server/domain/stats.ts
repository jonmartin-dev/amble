import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { groups, tasks, type Member } from '../db/schema.ts';
import { addDays, daysBetween, dateOf, planningDate, type Clock } from '../lib/dates.ts';
import { listMembers } from './household.ts';

export type TimeOfDayBucket = 'morning' | 'afternoon' | 'evening' | 'night';

export interface Stats {
  today: string;
  /** ISO weekday the weeks start on (1 is Monday, 7 is Sunday). */
  weekStart: number;
  members: { id: string; name: string; color: string; avatarUrl: string | null }[];
  /** Oldest first; the last one is this week. */
  weeks: { start: string; total: number; byMember: Record<string, number> }[];
  /** Completions in the window by ISO weekday, in display order. */
  weekdays: { day: number; count: number }[];
  timesOfDay: { key: TimeOfDayBucket; count: number }[];
  /** Groups with open tasks, most first. Added and done cover the last four weeks. */
  pilingUp: { groupId: string | null; name: string; icon: string; color: string; open: number; oldestDays: number; added: number; done: number }[];
  /** How Amble's size guesses held up: which ones people left alone, and how far they moved the rest. */
  estimates: {
    made: number;
    kept: number;
    raised: number;
    lowered: number;
    /** Across changed guesses, the person's number over Amble's, middle value. Null with none changed. */
    typicalRatio: number | null;
    /** The last six months, oldest first, so the trend shows. */
    months: { month: string; made: number; kept: number }[];
  };
  /** The viewer's own records, or null when they've turned them off. */
  records: {
    streak: { current: number; best: number };
    bestWeek: { start: string; count: number } | null;
    oldestDone: { taskId: string; title: string; days: number } | null;
    totalDone: number;
    since: string | null;
  } | null;
}

export function startOfWeek(date: string, weekStart: number) {
  const dow = Temporal.PlainDate.from(date).dayOfWeek;
  return addDays(date, -((dow - weekStart + 7) % 7));
}

function bucket(hour: number): TimeOfDayBucket {
  if (hour >= 4 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** Tasks in someone else's private group don't count for this viewer. */
const visibleTo = (memberId: string) => or(isNull(tasks.groupId), isNull(groups.privateTo), eq(groups.privateTo, memberId));

/**
 * Patterns in what gets done, from completed tasks. Members are listed side by side in household
 * order, never ranked.
 */
export function getStats(db: Db, me: Member, opts: { weeks?: number; weekStart?: number } = {}): Stats {
  const weekCount = Math.min(Math.max(opts.weeks ?? 12, 1), 52);
  const weekStart = opts.weekStart && opts.weekStart >= 1 && opts.weekStart <= 7 ? opts.weekStart : 1;
  const today = planningDate(me);
  const thisWeek = startOfWeek(today, weekStart);
  const windowStart = addDays(thisWeek, -7 * (weekCount - 1));
  const household = listMembers(db);
  const clocks = new Map<string, Clock>(household.map((m) => [m.id, m]));
  const clockOf = (id: string | null) => (id && clocks.get(id)) || me;

  const done = db
    .select({ id: tasks.id, title: tasks.title, completedAt: tasks.completedAt, completedById: tasks.completedById, createdAt: tasks.createdAt })
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .where(and(eq(tasks.status, 'done'), isNotNull(tasks.completedAt), visibleTo(me.id)))
    .all()
    .map((t) => ({ ...t, day: dateOf(clockOf(t.completedById), t.completedAt!) }));

  const weeks = Array.from({ length: weekCount }, (_, i) => ({ start: addDays(windowStart, i * 7), total: 0, byMember: {} as Record<string, number> }));
  const byWeekday = new Map<number, number>();
  const byTime = new Map<TimeOfDayBucket, number>();
  for (const t of done) {
    if (t.day < windowStart || t.day > today) continue;
    const week = weeks[Math.floor(daysBetween(windowStart, t.day) / 7)]!;
    week.total++;
    const who = t.completedById ?? 'unknown';
    week.byMember[who] = (week.byMember[who] ?? 0) + 1;
    const dow = Temporal.PlainDate.from(t.day).dayOfWeek;
    byWeekday.set(dow, (byWeekday.get(dow) ?? 0) + 1);
    const hour = Temporal.Instant.fromEpochMilliseconds(t.completedAt!.getTime()).toZonedDateTimeISO(clockOf(t.completedById).timezone).hour;
    byTime.set(bucket(hour), (byTime.get(bucket(hour)) ?? 0) + 1);
  }

  return {
    today,
    weekStart,
    members: household.map(({ id, name, color, avatarUrl }) => ({ id, name, color, avatarUrl })),
    weeks,
    weekdays: Array.from({ length: 7 }, (_, i) => {
      const day = ((weekStart - 1 + i) % 7) + 1;
      return { day, count: byWeekday.get(day) ?? 0 };
    }),
    timesOfDay: (['morning', 'afternoon', 'evening', 'night'] as const).map((key) => ({ key, count: byTime.get(key) ?? 0 })),
    pilingUp: pilingUp(db, me, today),
    estimates: estimates(db, me, today),
    records: me.showStreaks ? records(db, me, today, weekStart, done) : null,
  };
}

function estimates(db: Db, me: Member, today: string): Stats['estimates'] {
  const rows = db
    .select({ ai: tasks.aiEstimateMinutes, minutes: tasks.estimateMinutes, source: tasks.estimateSource, createdAt: tasks.createdAt })
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .where(and(isNotNull(tasks.aiEstimateMinutes), ne(tasks.status, 'archived'), visibleTo(me.id)))
    .all();
  // A guess someone cleared without giving their own says nothing about its size.
  const judged = rows.filter((r) => r.minutes != null);
  const changed = judged.filter((r) => r.minutes !== r.ai);
  const ratios = changed.map((r) => r.minutes! / r.ai!).sort((a, b) => a - b);
  const mid = ratios.length ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2]! : (ratios[ratios.length / 2 - 1]! + ratios[ratios.length / 2]!) / 2) : null;
  const thisMonth = Temporal.PlainDate.from(today).toPlainYearMonth();
  const months = Array.from({ length: 6 }, (_, i) => ({ month: thisMonth.subtract({ months: 5 - i }).toString(), made: 0, kept: 0 }));
  for (const r of judged) {
    const m = months.find((x) => x.month === dateOf(me, r.createdAt).slice(0, 7));
    if (!m) continue;
    m.made++;
    if (r.minutes === r.ai) m.kept++;
  }
  return {
    made: judged.length,
    kept: judged.length - changed.length,
    raised: changed.filter((r) => r.minutes! > r.ai!).length,
    lowered: changed.filter((r) => r.minutes! < r.ai!).length,
    typicalRatio: mid == null ? null : Math.round(mid * 100) / 100,
    months,
  };
}

function pilingUp(db: Db, me: Member, today: string): Stats['pilingUp'] {
  const since = new Date(Date.now() - 28 * 86_400_000);
  const rows = db
    .select({
      groupId: tasks.groupId,
      name: groups.name,
      icon: groups.icon,
      color: groups.color,
      open: sql<number>`sum(case when ${tasks.status} = 'open' then 1 else 0 end)`,
      oldest: sql<number | null>`min(case when ${tasks.status} = 'open' then ${tasks.createdAt} end)`,
      added: sql<number>`sum(case when ${tasks.createdAt} >= ${since.getTime()} then 1 else 0 end)`,
      done: sql<number>`sum(case when ${tasks.status} = 'done' and ${tasks.completedAt} >= ${since.getTime()} then 1 else 0 end)`,
    })
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .where(and(ne(tasks.status, 'archived'), visibleTo(me.id), or(isNull(tasks.groupId), eq(groups.kind, 'tasks'))))
    .groupBy(tasks.groupId)
    .all();
  return rows
    .filter((r) => r.open > 0)
    .map((r) => ({
      groupId: r.groupId,
      name: r.name ?? 'No group',
      icon: r.icon ?? 'folder',
      color: r.color ?? 'teal',
      open: r.open,
      oldestDays: r.oldest == null ? 0 : Math.max(0, daysBetween(dateOf(me, new Date(r.oldest)), today)),
      added: r.added,
      done: r.done,
    }))
    .sort((a, b) => b.open - a.open || b.oldestDays - a.oldestDays)
    .slice(0, 6);
}

function records(
  db: Db,
  me: Member,
  today: string,
  weekStart: number,
  done: { id: string; title: string; completedById: string | null; createdAt: Date; day: string }[],
): NonNullable<Stats['records']> {
  // A day list counts as finished when everything planned for it (theirs and shared) got done.
  // Days with nothing planned neither count nor break a streak, and today only counts once finished.
  const days = db
    .select({
      date: tasks.plannedDate,
      total: sql<number>`count(*)`,
      done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)`,
    })
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .where(
      and(
        ne(tasks.status, 'archived'),
        isNotNull(tasks.plannedDate),
        sql`${tasks.plannedDate} <= ${today}`,
        or(eq(tasks.assigneeId, me.id), isNull(tasks.assigneeId)),
        visibleTo(me.id),
      ),
    )
    .groupBy(tasks.plannedDate)
    .orderBy(tasks.plannedDate)
    .all()
    .map((d) => ({ date: d.date!, finished: d.done === d.total }))
    .filter((d) => d.date < today || d.finished);

  let run = 0;
  let best = 0;
  for (const d of days) {
    run = d.finished ? run + 1 : 0;
    best = Math.max(best, run);
  }

  const mine = done.filter((t) => t.completedById === me.id);
  const perWeek = new Map<string, number>();
  for (const t of mine) {
    const week = startOfWeek(t.day, weekStart);
    perWeek.set(week, (perWeek.get(week) ?? 0) + 1);
  }
  const bestWeek = [...perWeek].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];

  let oldest: { taskId: string; title: string; days: number } | null = null;
  for (const t of done) {
    const days = daysBetween(dateOf(me, t.createdAt), t.day);
    if (days >= 2 && (!oldest || days > oldest.days)) oldest = { taskId: t.id, title: t.title, days };
  }

  return {
    streak: { current: run, best },
    bestWeek: bestWeek ? { start: bestWeek[0], count: bestWeek[1] } : null,
    oldestDone: oldest,
    totalDone: mine.length,
    since: mine.reduce<string | null>((min, t) => (min == null || t.day < min ? t.day : min), null),
  };
}

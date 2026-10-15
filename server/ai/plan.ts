// The model's part in planning: wording the morning's reasons, adjusting a week's plan to what someone
// says about it, and suggesting how to tidy the backlog. The planner in domain/planner.ts makes
// the choices; everything here is checked against it before anyone sees it.
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { members, sessions, type Member } from '../db/schema.ts';
import { listEvents, type EventView } from '../domain/events.ts';
import { firstName, visibleGroups } from '../domain/household.ts';
import { DEFAULT_ESTIMATE_MINUTES, getLoad, loadLevel, type DayLoad } from '../domain/load.ts';
import { dayRecord, planWeek, saveReasons, suggestForDay, type DayPick, type Suggestion, type WeekPlan } from '../domain/planner.ts';
import { listTasks, type TaskDetail } from '../domain/tasks.ts';
import { addDays, planningDate, weekday } from '../lib/dates.ts';
import { AiUnavailable, ask as askModel, effortFor, requireAi, type Ai, type Effort } from './client.ts';

const ORGANIZE_TASKS = 150;
const ORGANIZE_MAX = 12;
// Briefings are written for people who've used Amble lately.
const ACTIVE_DAYS = 14;

async function ask<T extends z.ZodType>(
  db: Db,
  ai: Ai,
  me: Member | null,
  { feature, system, content, schema, effort, timezone }: { feature: string; system: string; content: string; schema: T; effort: Effort | 'chosen'; timezone: string },
): Promise<z.output<T>> {
  const setup = requireAi(ai, db, timezone);
  const { output } = await askModel(db, ai, {
    feature,
    memberId: me?.id ?? null,
    timezone,
    system,
    content,
    schema,
    // "chosen" is the admin's setting in Settings, AI, for the calls someone waits on.
    effort: effort === 'chosen' ? (setup.effort === 'default' ? null : setup.effort) : effortFor(setup, effort),
    maxTokens: 8000,
  });
  return output;
}

const clock = (iso: string, timeZone: string) =>
  Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone).toPlainTime().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

function eventLine(e: EventView, timeZone: string) {
  return e.allDay ? `all day: ${e.title ?? 'busy'}` : `${clock(e.start, timeZone)}-${clock(e.end, timeZone)} ${e.title ?? 'busy'}`;
}

function dayLine(d: DayLoad) {
  return `${d.weekday} ${d.date}: ${d.plannedMinutes} of ${d.capacityMinutes} task minutes planned${d.eventMinutes ? `, ${d.eventMinutes} minutes of calendar events (${d.usualEventMinutes} is usual)` : ''}`;
}

function taskLine(ref: string, t: TaskDetail, today: string) {
  // Days since it was added, as a sense of how long it's waited.
  return [
    `${ref} ${t.title}`,
    t.groupName,
    `${t.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES} min`,
    t.dueDate && `due ${weekday(t.dueDate)} ${t.dueDate}`,
    t.mustDo && 'must-do',
    t.plannedDate && t.plannedDate < today && `left over from ${t.plannedDate}`,
    `added ${Math.max(0, Math.floor((Date.now() - t.createdAt.getTime()) / 86_400_000))} days ago`,
  ]
    .filter(Boolean)
    .join(' · ');
}

const VOICE = `Amble is a calm household planner. Write the way a thoughtful friend would mention it: plain, warm, brief, second person. Never nag, scold or hype: no exclamation marks, no "don't forget", no "you should". Mention a calendar event only when it explains the reason. Never invent facts.`;

// ---- the morning's reasons -----------------------------------------------------------------------

const Reasons = z.object({
  reasons: z.array(z.object({ task: z.string().describe('The task ref, like t1'), reason: z.string() })),
});

/** The model rewords the planner's reasons for today's suggestions; any it skips keep the built-in ones. */
export async function wordReasons(db: Db, ai: Ai, me: Member, suggestions: Suggestion[], timezone: string) {
  const today = planningDate(me);
  const days = getLoad(db, me, me, today, addDays(today, 6));
  const events = listEvents(db, me, today, addDays(today, 6));
  const refs = new Map(suggestions.map((s, i) => [`t${i + 1}`, s]));
  const content = [
    `Today is ${weekday(today)} ${today}. ${firstName(me)} is reading their morning briefing.`,
    '',
    'The week ahead:',
    ...days.map((d) => {
      const own = events.filter((e) => (e.allDay ? e.startDate! <= d.date && d.date < e.endDate! : clockDate(e.start, me.timezone) === d.date));
      return `${dayLine(d)}${own.length ? `\n  ${own.map((e) => eventLine(e, me.timezone)).join('; ')}` : ''}`;
    }),
    '',
    'Suggested for today, with why the planner picked each:',
    ...[...refs].map(([ref, s]) => `${taskLine(ref, s.task, today)}\n  planner's reason: ${s.reason}`),
  ].join('\n');
  const out = await ask(db, ai, me, {
    feature: 'briefing',
    effort: 'low',
    timezone,
    schema: Reasons,
    system: `You write the one-line reason under each task Amble suggests doing today. Keep the planner's facts (deadlines, how full days are) and say them naturally, in one short sentence of at most 15 words. ${VOICE}`,
    content,
  });
  const reasons = new Map<string, string>();
  for (const r of out.reasons) {
    const s = refs.get(r.task);
    const text = r.reason.trim().replace(/\s+/g, ' ');
    if (s && text && text.length <= 160) reasons.set(s.task.id, text);
  }
  return reasons;
}

const clockDate = (iso: string, timeZone: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone).toPlainDate().toString();

/**
 * Writes today's suggestions and their reasons ahead of the first open, once per person per day,
 * with the model's wording when it's available.
 */
export function createBriefings(db: Db, ai: Ai, timezone: string) {
  return {
    async run() {
      const since = new Date(Date.now() - ACTIVE_DAYS * 86_400_000);
      const active = db
        .selectDistinct({ id: members.id })
        .from(members)
        .innerJoin(sessions, eq(sessions.memberId, members.id))
        .where(and(gt(sessions.lastSeenAt, since)))
        .all();
      for (const { id } of active) {
        const me = db.select().from(members).where(eq(members.id, id)).get();
        if (!me) continue;
        const date = planningDate(me);
        const record = dayRecord(db, me.id, date);
        if (record.reasonsBy) continue;
        const suggestions = suggestForDay(db, me, { exclude: new Set(record.dismissed) });
        let reasons = new Map<string, string>();
        let by: 'ai' | 'template' = 'template';
        if (suggestions.length && ai.available) {
          try {
            reasons = await wordReasons(db, ai, me, suggestions, timezone);
            by = 'ai';
          } catch (err) {
            if (!(err instanceof AiUnavailable)) throw err;
            console.warn('Briefing reasons fell back:', err.message);
          }
        }
        saveReasons(db, me, date, suggestions.map((s) => ({ taskId: s.task.id, reason: reasons.get(s.task.id) ?? s.reason })), by);
      }
    },
  };
}

// ---- plan my week -------------------------------------------------------------------------------

const PlanOut = z.object({
  plan: z.array(
    z.object({
      task: z.string().describe('A task ref like t3'),
      day: z.string().describe('YYYY-MM-DD within the week, or "" to leave it in the backlog'),
      reason: z.string(),
    }),
  ),
  note: z.string().describe('One short sentence about the week for the person, or ""'),
});

export interface PlannedWeek extends WeekPlan {
  note: string | null;
  by: 'ai' | 'planner';
}

/**
 * The planner's week, then, when someone has said something about it ("keep Saturday free") or
 * the model is set up, its adjustments. Deadlines still hold: a task never lands after it's due.
 */
export async function planMyWeek(db: Db, ai: Ai, me: Member, { note, timezone }: { note?: string; timezone: string }): Promise<PlannedWeek> {
  const base = planWeek(db, me);
  if (!ai.available) return { ...base, note: null, by: 'planner' };
  const today = base.start;
  const end = addDays(today, 6);
  const before = getLoad(db, me, me, today, end);
  const events = listEvents(db, me, today, end);
  // The model sees the planner's picks and a few more backlog tasks it could swap in.
  const picked = new Set(base.picks.map((p) => p.task.id));
  const spare = listTasks(db, me, { status: 'open', unplanned: true, assignee: { memberId: me.id, includeShared: true } })
    .filter((t) => !picked.has(t.id))
    .slice(0, 15);
  const tasksByRef = new Map<string, TaskDetail>([...base.picks.map((p) => p.task), ...spare].map((t, i) => [`t${i + 1}`, t]));
  const refOf = new Map([...tasksByRef].map(([r, t]) => [t.id, r]));
  const content = [
    `Today is ${weekday(today)} ${today}. ${firstName(me)} asked Amble to plan their week (${today} to ${end}).`,
    note?.trim() ? `They said: """${note.trim().slice(0, 500)}"""` : 'They added nothing to keep in mind.',
    '',
    'Days, before the plan:',
    ...before.map((d) => {
      const own = events.filter((e) => (e.allDay ? e.startDate! <= d.date && d.date < e.endDate! : clockDate(e.start, me.timezone) === d.date));
      return `${dayLine(d)}${own.length ? `\n  ${own.map((e) => eventLine(e, me.timezone)).join('; ')}` : ''}`;
    }),
    '',
    "The planner's picks:",
    ...base.picks.map((p) => `${taskLine(refOf.get(p.task.id)!, p.task, today)} → ${p.weekday} ${p.date}`),
    '',
    'Other backlog tasks it left out:',
    ...(spare.length ? spare.map((t) => taskLine(refOf.get(t.id)!, t, today)) : ['none']),
  ].join('\n');

  let out;
  try {
    out = await ask(db, ai, me, {
      feature: 'plan_week',
      effort: 'chosen',
      timezone,
      schema: PlanOut,
      system: `You help plan someone's week in Amble. The planner already placed tasks on the days with the most room. Keep its plan unless what they said, or something clear in the calendar, gives a reason to change it. Follow what they said exactly ("keep Saturday free" means nothing goes on Saturday). Never put a task after its due date, never fill a day past its task minutes when another day has room, and leave a task out (day "") rather than overload the week. Give every planned task a reason of at most 12 words, and add a one-sentence note only if it helps. ${VOICE}`,
      content,
    });
  } catch (err) {
    if (!(err instanceof AiUnavailable)) throw err;
    console.warn('Plan my week fell back:', err.message);
    return { ...base, note: null, by: 'planner' };
  }

  const picks: DayPick[] = [];
  const seen = new Set<string>();
  for (const item of out.plan) {
    const task = tasksByRef.get(item.task);
    if (!task || seen.has(task.id) || !item.day) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.day) || item.day < today || item.day > end) continue;
    const deadline = task.dueDate && task.dueDate >= today ? task.dueDate : null;
    const date = deadline && item.day > deadline ? deadline : item.day;
    seen.add(task.id);
    picks.push({ task, date, weekday: weekday(date), fits: true, reason: item.reason.trim() || 'Fits here.' });
  }
  // Tasks the planner had to place (left over, or due this week) stay in, on its day, if the model dropped them.
  for (const p of base.picks) {
    const must = !!p.task.plannedDate || (!!p.task.dueDate && p.task.dueDate <= end);
    if (must && !seen.has(p.task.id)) picks.push(p);
  }
  const days = before.map((d) => {
    const added = picks.filter((p) => p.date === d.date);
    const plannedMinutes = d.plannedMinutes + added.reduce((n, p) => n + (p.task.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES), 0);
    return { ...d, plannedMinutes, tasks: d.tasks + added.length, level: loadLevel(plannedMinutes, d.capacityMinutes) };
  });
  for (const p of picks) p.fits = days.find((d) => d.date === p.date)!.plannedMinutes <= days.find((d) => d.date === p.date)!.capacityMinutes;
  picks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { start: today, days, picks, note: out.note.trim() || null, by: 'ai' };
}

// ---- organize the backlog -----------------------------------------------------------------------

const OrganizeOut = z.object({
  suggestions: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('regroup'), task: z.string(), group: z.string().describe('A group ref like g2'), reason: z.string() }),
      z.object({ kind: z.literal('merge'), tasks: z.array(z.string()).describe('Two or more task refs that are the same thing'), title: z.string().describe('The title for the one that stays'), reason: z.string() }),
      z.object({ kind: z.literal('split'), task: z.string(), into: z.array(z.string()).describe('Two to six separate tasks, each a clear action'), reason: z.string() }),
    ]),
  ),
});

export type OrganizeSuggestion =
  | { kind: 'regroup'; taskId: string; title: string; groupId: string; groupName: string; reason: string }
  | { kind: 'merge'; taskIds: string[]; titles: string[]; title: string; reason: string }
  | { kind: 'split'; taskId: string; title: string; into: string[]; reason: string };

/** Ways to tidy the open tasks: move ones into the group they belong in, merge duplicates, split ones that are really several. */
export async function organizeBacklog(db: Db, ai: Ai, me: Member, timezone: string): Promise<OrganizeSuggestion[]> {
  const today = planningDate(me);
  const groups = visibleGroups(db, me.id).filter((g) => g.kind === 'tasks');
  const groupRefs = new Map(groups.map((g, i) => [`g${i + 1}`, g]));
  const open = listTasks(db, me, { status: 'open', limit: ORGANIZE_TASKS });
  const refs = new Map(open.map((t, i) => [`t${i + 1}`, t]));
  const content = [
    'Groups:',
    ...[...groupRefs].map(([r, g]) => `${r} ${g.name}${g.privateTo ? ' (private)' : ''}`),
    '',
    'Open tasks:',
    ...[...refs].map(([r, t]) => {
      const steps = t.subtasks.length ? `${t.subtasks.length} steps` : null;
      const notes = t.notes ? `notes: ${t.notes.replace(/\s+/g, ' ').slice(0, 120)}` : null;
      return [taskLine(r, t, today), t.groupName ? null : 'no group', steps, notes].filter(Boolean).join(' · ');
    }),
  ].join('\n');
  const out = await ask(db, ai, me, {
    feature: 'organize',
    effort: 'chosen',
    timezone,
    schema: OrganizeOut,
    system: `You suggest a few ways to tidy a household's open tasks in Amble. Only suggest what clearly helps:
- regroup: a task with no group, or plainly in the wrong one, into the group it belongs in.
- merge: two or more tasks that are the same thing written twice. Not merely related tasks.
- split: a task that is really several separate jobs ("clean the garage and fix the bike"), into those jobs. Not a task that just has steps.
At most ${ORGANIZE_MAX} suggestions, the most useful first, and none at all if the tasks are already tidy. Each reason is one short sentence. ${VOICE}`,
    content,
  });
  const result: OrganizeSuggestion[] = [];
  const used = new Set<string>();
  for (const s of out.suggestions) {
    if (result.length >= ORGANIZE_MAX) break;
    const reason = s.reason.trim();
    if (s.kind === 'regroup') {
      const t = refs.get(s.task);
      const g = groupRefs.get(s.group);
      if (!t || !g || g.id === t.groupId || used.has(t.id)) continue;
      used.add(t.id);
      result.push({ kind: 'regroup', taskId: t.id, title: t.title, groupId: g.id, groupName: g.name, reason });
    } else if (s.kind === 'merge') {
      const ts = [...new Set(s.tasks)].map((r) => refs.get(r)).filter((t): t is TaskDetail => !!t && !used.has(t.id));
      const title = s.title.trim();
      if (ts.length < 2 || !title) continue;
      ts.forEach((t) => used.add(t.id));
      result.push({ kind: 'merge', taskIds: ts.map((t) => t.id), titles: ts.map((t) => t.title), title, reason });
    } else {
      const t = refs.get(s.task);
      const into = s.into.map((x) => x.trim()).filter(Boolean).slice(0, 6);
      if (!t || into.length < 2 || used.has(t.id)) continue;
      used.add(t.id);
      result.push({ kind: 'split', taskId: t.id, title: t.title, into, reason });
    }
  }
  return result;
}

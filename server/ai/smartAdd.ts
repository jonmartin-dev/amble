// Smart add: the model reads what someone typed into quick add, with the household's context, and
// proposes tasks, list items and changes. The person reviews them; nothing is saved here.
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AddHints, Proposal, ProposedTask, TaskChanges } from '../../shared/proposals.ts';
import { listSections, listTemplate } from '../../shared/templates.ts';
import type { Db } from '../db/index.ts';
import { listItems, tasks, type Member } from '../db/schema.ts';
import { firstName, listMembers, visibleGroups } from '../domain/household.ts';
import { getLoad } from '../domain/load.ts';
import { parseReminderTime } from '../domain/reminders.ts';
import { cleanRepeat } from '../domain/repeat.ts';
import { listTasks } from '../domain/tasks.ts';
import { addDays, planningDate, weekday } from '../lib/dates.ts';
import { ask, requireAi, type Ai, type Effort } from './client.ts';

const OPEN_TASKS_SHOWN = 150;
const EXAMPLES_PER_GROUP = 6;
const HISTORY_PER_LIST = 40;
const SIZE_EXAMPLES = 20;
const LOAD_DAYS = 14;

// ---- what the model answers with ------------------------------------------------------------
// Refs like g2 or t14 stand for the household's groups and tasks; the server maps them back.
// Every field is required, with "" or 0 for "not set": the API limits how many fields a schema
// can leave optional or nullable.

const RepeatOut = z.object({
  mode: z.enum(['none', 'schedule', 'after']).describe('"none" unless they said it repeats. "schedule" follows the calendar; "after" counts from when the last one was done'),
  every: z.number().int().describe('Every this many units (1 or more); 0 when mode is none'),
  unit: z.enum(['day', 'week', 'month', 'year']),
  weekdays: z.array(z.number().int()).describe('Weekly: 1 = Monday ... 7 = Sunday; empty otherwise'),
  day: z.number().int().describe('Monthly or yearly: day of the month, -1 for the last day; 0 if not used'),
  nth: z.number().int().describe('Monthly: which weekday of the month, 1-4 or -1 for last, with weekday; 0 if not used'),
  weekday: z.number().int().describe('Monthly with nth: 1 = Monday ... 7 = Sunday; 0 if not used'),
  month: z.number().int().describe('Yearly: month 1-12; 0 if not used'),
  months: z.array(z.number().int()).describe('Only in these months (1-12), for seasonal chores; empty for all year'),
});

const TaskOut = z.object({
  title: z.string(),
  notes: z.string().describe('"" for none'),
  group: z.string().describe('A group ref like g2, or ""'),
  for: z.string().describe('A person ref like m2, "anyone", or "" for the person typing'),
  planned: z.string().describe('YYYY-MM-DD: the day to do it, which puts it on that day\'s list; or ""'),
  due: z.string().describe('YYYY-MM-DD: a real deadline; or ""'),
  time_of_day: z.enum(['', 'morning', 'afternoon', 'evening']),
  must_do: z.boolean(),
  estimate_minutes: z.number().int().describe('How long it will take, in minutes'),
  steps: z.array(z.string()),
  links: z.array(z.string()),
  repeat: RepeatOut,
  remind: z.string().describe('YYYY-MM-DDTHH:MM, their local time, only when they ask to be reminded; or ""'),
});

const Item = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_task'), task: TaskOut }),
  z.object({
    kind: z.literal('add_to_list'),
    list: z.string().describe('A list ref like l1'),
    name: z.string(),
    quantity: z.string().describe('"" for none'),
    section: z.string().describe("One of the list's sections (a new one only where the list says new ones are fine), or \"\""),
    store: z.string().describe('Where to buy it, on lists with stores, when they said; "" for none'),
    note: z.string().describe('"" for none'),
  }),
  z.object({
    kind: z.literal('update_task'),
    task: z.string().describe('An open task ref like t3'),
    title: z.string().describe('"" to keep'),
    notes: z.string().describe('"" to keep'),
    group: z.string().describe('A group ref, "none" to clear, "" to keep'),
    for: z.string().describe('A person ref or "anyone"; "" to keep'),
    planned: z.string().describe('YYYY-MM-DD, "none" to put it back in the backlog, "" to keep'),
    due: z.string().describe('YYYY-MM-DD, "none" to clear, "" to keep'),
    time_of_day: z.enum(['', 'morning', 'afternoon', 'evening', 'none']).describe('"" to keep, "none" to clear'),
    must_do: z.enum(['', 'yes', 'no']).describe('"" to keep'),
    estimate_minutes: z.number().int().describe('0 to keep'),
    add_steps: z.array(z.string()),
    repeat: RepeatOut.describe('mode "none" to keep'),
    remind: z.string().describe('YYYY-MM-DDTHH:MM to remind them, "none" to clear, "" to keep'),
  }),
  z.object({ kind: z.literal('complete_task'), task: z.string().describe('An open task ref like t3') }),
  z.object({ kind: z.literal('check_off'), list: z.string(), item: z.string().describe('An item ref like i4 from what is on the list now') }),
]);

const Output = z.object({
  items: z.array(Item),
  unclear: z.string().describe('Anything you could not make sense of, in one short sentence to the person; "" if everything made sense'),
});
export type SmartAddOutput = z.infer<typeof Output>;
type Output = SmartAddOutput;

// ---- the prompt -----------------------------------------------------------------------------

const SYSTEM = `You turn what someone typed into Amble's quick add into proposals. They will review every proposal before anything is saved, so propose what they most likely meant, completely, and nothing they didn't ask for.

Amble is a calm, shared household planner. Tasks live in groups; lists hold shopping-style items. "Planned" is the day someone means to do a task (it goes on that day's list). "Due" is a real deadline. A task with neither sits in the backlog, which is fine: don't schedule things nobody asked to schedule.

What to propose:
- add_task for each separate thing to do. Split a brain dump or a list of chores into one task each. When one thing has parts ("taxes: W-2, 1099, mortgage form"), make one task with steps.
- add_to_list for things to buy or pack. Groceries and household supplies go on the groceries list; other purchases go on a shopping list if there is one, otherwise make a task ("Buy a drill bit set") in the group that fits. Never make tasks for grocery items. But buying with a day, deadline or errand attached ("pick up a gift for Sam this weekend", "get a costume before Friday's party") is a task, so it lands on a day.
- update_task when they're clearly talking about an open task already listed ("the dentist is actually Friday", "mow the lawn should be Alex's"). Change only what they said. Use it instead of adding a duplicate of an open task.
- complete_task when they say an open task is done ("called the plumber"). check_off when they say they got something on a list ("got the milk").

Writing tasks:
- Titles are short and actionable, in their words, starting with a capital letter, with no trailing period. Take dates, times, people and urgency out of the title once they're captured in fields ("call mom tomorrow evening" becomes "Call Mom", planned tomorrow, evening).
- Keep names, numbers, places and other specifics they gave. Put extra detail that doesn't fit the title in notes, briefly. Never invent details.
- links: any URLs they included.

Fields (every field is always present; "" or 0 or an empty list means not set, and repeat mode is "none" unless it repeats):
- planned: when they name a day or time to do it ("tomorrow", "Friday", "on the 3rd", "tonight"). A weekday name means the next one on or after today. "This week", "next week" or "this weekend" without a day: pick the day in that range with the most room for that person in the load table. No timing words: "" (backlog).
- due: deadline words ("by Friday", "before the 15th", "due", "deadline", "expires"). Don't also set planned unless they said when they'll do it.
- time_of_day: only when they say it. Morning (or a clock time before noon); afternoon (lunch, or noon to 5pm); evening (tonight, after work, or 5pm on). Put an exact clock time in notes too ("At 2pm").
- must_do: only when they stress it ("must", "have to today", "important", "urgent", "don't forget", "!!").
- for: "" for the person typing. A person named as doing it ("Alex should", "ask Alex to", "for Alex") gets it. "Us", "we", "either of us", "whoever" or "anyone" means "anyone".
- group: the group that fits, judging by what's already in each group. "" when none fits.
- estimate_minutes: always, for every task. A realistic time for doing the task itself, matching this household's own estimates when similar tasks are listed. Quick calls and messages 5-15, small chores 15-30, errands 30-60, bigger jobs 60-240.
- repeat: only when they say it repeats ("every Sunday", "weekly", "on the 1st of each month", "every other Tuesday", "every 3 months"). Use mode "schedule" for calendar rhythms. Use mode "after" for maintenance whose clock restarts when it's done (filters, haircuts, oil changes) unless they tie it to calendar dates. Add months for seasonal ones ("mow every Saturday from April to October"). Don't set planned on a repeating task unless they said when to start.
- remind: only when they ask to be reminded or nudged ("remind me", "ping me", "nudge me", "alert me"). It's a phone notification for the person typing, in their local time, and it has to be later than now. A day with no clock time means 09:00; "tonight" or "this evening" 18:00; "this afternoon" 14:00; "in an hour" or "in 20 minutes" counts from now. Plan the task for the reminder's day too, unless they gave another day for doing it. "Don't forget" alone is must_do, not a reminder.

List items:
- name: the item alone, as this household names it. When the list's history has the household's own version of what they said, use that: "milk" is their "Oat milk", "bread" their "Sourdough bread". Otherwise use their words. Capitalize the first letter.
- quantity: amounts and sizes, separate from the name ("2 lbs chicken thighs" becomes "Chicken thighs", "2 lbs").
- section: the best fit from the list's sections, when it has them. On lists whose sections are people or places, use the one they named ("for Mom", "at Target"), matching an existing one when it's the same, or a new one.
- store: only on lists with stores, and only when they named one ("at Costco").

If part of the text can't be interpreted at all, say so briefly in unclear instead of guessing. Most text is simply a task.`;

interface Refs {
  members: Map<string, Member>;
  groups: Map<string, string>;
  lists: Map<string, { id: string; sections: string[]; free: boolean; stores: boolean }>;
  tasks: Map<string, { id: string; title: string }>;
  items: Map<string, { id: string; listId: string; name: string }>;
}

function line(...parts: (string | null | undefined | false)[]) {
  return parts.filter(Boolean).join(' · ');
}

/** Sizes people set themselves, most recent first, one per title: examples of how long things take here. */
export function ownEstimates(db: Db, limit: number) {
  const sized = db
    .select({ title: tasks.title, minutes: tasks.estimateMinutes })
    .from(tasks)
    .where(eq(tasks.estimateSource, 'user'))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit * 3)
    .all();
  return [...new Map(sized.map((s) => [s.title.toLowerCase(), s])).values()].slice(0, limit);
}

/** The household as the model needs it, with short refs in place of ids. */
export function buildContext(db: Db, me: Member, hints: AddHints = {}) {
  const today = planningDate(me);
  const refs: Refs = { members: new Map(), groups: new Map(), lists: new Map(), tasks: new Map(), items: new Map() };
  const out: string[] = [];

  const people = listMembers(db);
  const ref = new Map<string, string>();
  people.forEach((m, i) => {
    refs.members.set(`m${i + 1}`, m);
    ref.set(m.id, `m${i + 1}`);
  });
  const now = Temporal.Now.zonedDateTimeISO(me.timezone);
  out.push(
    `Today is ${weekday(today)} ${today}, and it's ${now.toPlainDateTime().toString({ smallestUnit: 'minute' })} now. The day turns over at ${me.dayCutoffHour}am, ${me.timezone}. ${firstName(me)} (${ref.get(me.id)}) is typing.`,
  );
  out.push('', 'People:', ...people.map((m) => `${ref.get(m.id)} ${m.name}${m.id === me.id ? ' (typing)' : ''}`));

  const end = addDays(today, LOAD_DAYS - 1);
  const loads = people.map((m) => getLoad(db, me, m, today, end));
  out.push('', `Next ${LOAD_DAYS} days: minutes already planned / minutes that fit, per person.`);
  out.push(['date        day', ...people.map((m) => ref.get(m.id)!.padEnd(9))].join('  '));
  for (let i = 0; i < LOAD_DAYS; i++) {
    const day = loads[0]![i]!;
    out.push([`${day.date}  ${day.weekday}`, ...loads.map((l) => `${l[i]!.plannedMinutes}/${l[i]!.capacityMinutes}`.padEnd(9))].join('  '));
  }

  const groups = visibleGroups(db, me.id);
  const taskGroups = groups.filter((g) => g.kind === 'tasks');
  out.push('', 'Task groups, each with tasks recently in it:');
  taskGroups.forEach((g, i) => {
    const r = `g${i + 1}`;
    refs.groups.set(r, g.id);
    const examples = listTasks(db, me, { groupId: g.id, status: 'all', order: 'recent', limit: EXAMPLES_PER_GROUP }).map((t) => t.title);
    out.push(`${r} ${g.name}${g.privateTo ? ' (private)' : ''}: ${examples.join('; ') || 'nothing yet'}`);
  });

  const lists = groups.filter((g) => g.kind === 'list');
  out.push('', 'Lists:');
  if (lists.length === 0) out.push('none');
  let itemCount = 0;
  lists.forEach((g, i) => {
    const r = `l${i + 1}`;
    const template = listTemplate(g.template);
    const open = db
      .select()
      .from(listItems)
      .where(and(eq(listItems.groupId, g.id), isNull(listItems.checkedAt)))
      .all();
    // Free-form sections, like who a gift is for, are whatever the items already use.
    const free = !!template.sections?.free;
    const sections = listSections(g, open.map((it) => it.section));
    const stores = !!template.fields.store;
    refs.lists.set(r, { id: g.id, sections, free, stores });
    const label = template.sections?.label.toLowerCase() ?? 'section';
    const sectionText = free
      ? `; sections are by ${label}${sections.length ? `: ${sections.join(', ')}` : ''}, and new ones are fine`
      : sections.length
        ? `; ${label} sections: ${sections.join(', ')}`
        : '';
    const storeNames = stores ? [...new Set(open.map((it) => it.store).filter(Boolean))] : [];
    out.push(
      `${r} ${g.name} (${template.name.toLowerCase()} list${sectionText}${stores ? `; has stores${storeNames.length ? `: ${storeNames.join(', ')}` : ''}` : ''})${template.hint ? ` ${template.hint}` : ''}`,
    );
    out.push(
      `  On it now: ${
        open
          .map((it) => {
            const ir = `i${++itemCount}`;
            refs.items.set(ir, { id: it.id, listId: g.id, name: it.name });
            return `${ir} ${it.name}${it.quantity ? ` (${it.quantity})` : ''}`;
          })
          .join('; ') || 'nothing'
      }`,
    );
    const history = db
      .select({ name: listItems.name })
      .from(listItems)
      .where(and(eq(listItems.groupId, g.id), isNotNull(listItems.checkedAt)))
      .orderBy(desc(listItems.checkedAt))
      .limit(HISTORY_PER_LIST)
      .all();
    if (history.length) out.push(`  Bought or packed before: ${[...new Set(history.map((h) => h.name))].join('; ')}`);
  });

  const open = listTasks(db, me, { status: 'open', order: 'recent', limit: OPEN_TASKS_SHOWN });
  out.push('', 'Open tasks:');
  if (open.length === 0) out.push('none');
  open.forEach((t, i) => {
    const r = `t${i + 1}`;
    refs.tasks.set(r, { id: t.id, title: t.title });
    out.push(
      `${r} ${line(
        t.title,
        t.groupName,
        t.assigneeId ? `for ${ref.get(t.assigneeId) ?? 'someone'}` : 'for anyone',
        t.plannedDate && `planned ${t.plannedDate}`,
        t.dueDate && `due ${t.dueDate}`,
        t.repeat && 'repeats',
      )}`,
    );
  });

  const sizes = ownEstimates(db, SIZE_EXAMPLES);
  if (sizes.length) out.push('', 'How long things take here (their own estimates):', sizes.map((s) => `${s.title}: ${s.minutes} min`).join('; '));

  const explicit = new Set(hints.explicit ?? []);
  const picked: string[] = [];
  const soft: string[] = [];
  const note = (key: NonNullable<AddHints['explicit']>[number], text: string) => (explicit.has(key) ? picked : soft).push(text);
  if (hints.plannedDate) note('plannedDate', `planned ${hints.plannedDate}`);
  if (hints.dueDate) note('dueDate', `due ${hints.dueDate}`);
  if (hints.groupId) {
    const g = [...refs.groups].find(([, id]) => id === hints.groupId)?.[0];
    if (g) note('groupId', `group ${g}`);
  }
  if (hints.assigneeId !== undefined) {
    note('assigneeId', hints.assigneeId === null ? 'for anyone' : `for ${ref.get(hints.assigneeId) ?? 'the person typing'}`);
  }
  if (hints.timeOfDay) note('timeOfDay', hints.timeOfDay);
  if (hints.mustDo) note('mustDo', 'must do');
  if (picked.length) out.push('', `They picked these in the add sheet; apply them to new tasks unless the text says otherwise: ${picked.join(', ')}.`);
  if (soft.includes(`planned ${today}`)) {
    out.push(
      '',
      "They opened the add sheet from today's list. If they typed one or two things with no timing words, plan them for today. In a longer list, plan for today only what sounds like today.",
    );
  }

  return { text: out.join('\n'), refs, today };
}

// ---- turning the model's answer into proposals ----------------------------------------------

// Every field comes back, with null for "not set" (the API limits how many can be optional).
type Maybe<T> = T | null | undefined;
const isDate = (v: Maybe<string>): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export const roundEstimate = (m: Maybe<number>) =>
  m && Number.isFinite(m) && m > 0 ? Math.min(1440, m < 10 ? Math.round(m) : Math.round(m / 5) * 5) : null;
const clean = (s: Maybe<string>) => s?.trim().replace(/\s+/g, ' ') || null;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const urls = (list: Maybe<string[]>) => (list ?? []).filter((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol)).slice(0, 20);
const steps = (list: Maybe<string[]>) =>
  (list ?? [])
    .map((s) => clean(s))
    .filter((s): s is string => !!s)
    .slice(0, 50);

/** A reminder time the model gave, as an instant, if it's a real time still to come. */
function reminderAt(value: Maybe<string>, timeZone: string): string | null {
  if (!value || value === 'none') return null;
  try {
    const at = parseReminderTime(value, timeZone);
    return at.getTime() > Date.now() ? at.toISOString() : null;
  } catch {
    return null;
  }
}

function repeatOf(r: z.infer<typeof RepeatOut>) {
  if (r.mode === 'none') return null;
  try {
    return cleanRepeat({
      mode: r.mode,
      every: r.every,
      unit: r.unit,
      weekdays: r.weekdays.length ? r.weekdays : null,
      day: r.day || null,
      nth: r.nth || null,
      weekday: r.weekday || null,
      month: r.month || null,
      months: r.months.length ? r.months : null,
    });
  } catch {
    return null;
  }
}

export function toProposals(output: Output, refs: Refs, me: Member, today: string): Proposal[] {
  // undefined: not said; null: anyone.
  const person = (r: Maybe<string>): string | null | undefined => {
    if (!r) return undefined;
    if (r.toLowerCase() === 'anyone') return null;
    return refs.members.get(r)?.id;
  };
  const proposals: Proposal[] = [];
  for (const item of output.items) {
    if (item.kind === 'add_task') {
      const t = item.task;
      const title = clean(t.title);
      if (!title) continue;
      const assignee = person(t.for);
      const task: ProposedTask = {
        title: capital(title).replace(/\.$/, ''),
        notes: clean(t.notes),
        groupId: (t.group && refs.groups.get(t.group)) || null,
        assigneeId: assignee === undefined ? me.id : assignee,
        plannedDate: isDate(t.planned) && t.planned >= today ? t.planned : null,
        dueDate: isDate(t.due) ? t.due : null,
        timeOfDay: t.time_of_day || null,
        mustDo: t.must_do,
        estimateMinutes: roundEstimate(t.estimate_minutes),
        estimateSource: 'ai',
        subtasks: steps(t.steps),
        links: urls(t.links),
        repeat: repeatOf(t.repeat),
        remindAt: reminderAt(t.remind, me.timezone),
      };
      proposals.push({ kind: 'task', task });
    } else if (item.kind === 'add_to_list') {
      const list = refs.lists.get(item.list);
      const name = clean(item.name);
      if (!list || !name) continue;
      const asked = clean(item.section);
      const section = (asked && list.sections.find((s) => s.toLowerCase() === asked.toLowerCase())) ?? (list.free && asked ? capital(asked) : null);
      const store = list.stores ? clean(item.store) : null;
      proposals.push({ kind: 'list_item', listId: list.id, name: capital(name), quantity: clean(item.quantity), section, note: clean(item.note), ...(store && { store }) });
    } else if (item.kind === 'update_task') {
      const task = refs.tasks.get(item.task);
      if (!task) continue;
      const changes: TaskChanges = {};
      if (clean(item.title)) changes.title = capital(clean(item.title)!);
      if (clean(item.notes)) changes.notes = clean(item.notes);
      if (item.group) changes.groupId = item.group === 'none' ? null : refs.groups.get(item.group);
      const p = person(item.for);
      if (p !== undefined) changes.assigneeId = p;
      if (item.planned === 'none') changes.plannedDate = null;
      else if (isDate(item.planned) && item.planned >= today) changes.plannedDate = item.planned;
      if (item.due === 'none') changes.dueDate = null;
      else if (isDate(item.due)) changes.dueDate = item.due;
      if (item.time_of_day) changes.timeOfDay = item.time_of_day === 'none' ? null : item.time_of_day;
      if (item.must_do) changes.mustDo = item.must_do === 'yes';
      if (item.estimate_minutes) changes.estimateMinutes = roundEstimate(item.estimate_minutes);
      if (item.add_steps?.length) changes.addSubtasks = steps(item.add_steps);
      const repeat = repeatOf(item.repeat);
      if (repeat) changes.repeat = repeat;
      if (item.remind === 'none') changes.remindAt = null;
      else if (item.remind) changes.remindAt = reminderAt(item.remind, me.timezone) ?? undefined;
      for (const k of Object.keys(changes) as (keyof TaskChanges)[]) if (changes[k] === undefined) delete changes[k];
      if (Object.keys(changes).length) proposals.push({ kind: 'update', taskId: task.id, title: task.title, changes });
    } else if (item.kind === 'complete_task') {
      const task = refs.tasks.get(item.task);
      if (task && !proposals.some((p) => p.kind === 'complete' && p.taskId === task.id)) {
        proposals.push({ kind: 'complete', taskId: task.id, title: task.title });
      }
    } else {
      const it = refs.items.get(item.item);
      if (it) proposals.push({ kind: 'check', listId: it.listId, itemId: it.id, name: it.name });
    }
  }
  return proposals;
}

// ---- reading the answer as it's written ------------------------------------------------------

/**
 * The entries of the answer's "items" list that are written out in full so far, from the start of
 * an answer still being written. Whatever comes before the JSON (thinking, a code fence) is passed
 * over; nothing is read while a model is still thinking aloud.
 */
export function itemsSoFar(text: string): unknown[] {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (s.includes('<think>')) return [];
  const items: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let lastString = '';
  let key = '';
  // Depth 1 is the answer, 2 the items list, 3 one item.
  let inItems = false;
  let itemStart = -1;
  for (let i = Math.max(0, s.indexOf('{')); i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        lastString = s.slice(stringStart + 1, i);
      }
    } else if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === ':' && depth === 1) key = lastString;
    else if (ch === '{' || ch === '[') {
      depth++;
      if (depth === 2 && ch === '[' && key === 'items') inItems = true;
      else if (depth === 3 && inItems && ch === '{') itemStart = i;
    } else if (ch === '}' || ch === ']') {
      if (depth === 3 && itemStart >= 0) {
        try {
          items.push(JSON.parse(s.slice(itemStart, i + 1)));
        } catch {
          // Not an item after all; the full answer is checked at the end anyway.
        }
        itemStart = -1;
      } else if (depth === 2) inItems = false;
      depth--;
    }
  }
  return items;
}

/**
 * What to hand the model call so that each proposal goes to `onProposal` as soon as the model has
 * written it: the same proposals, in the same order, that the whole answer makes at the end.
 */
function proposalsAsWritten(refs: Refs, me: Member, today: string, onProposal: (p: Proposal) => void) {
  let text = '';
  let sent = 0;
  return (piece: string) => {
    text += piece;
    // An item can only have ended where a brace or bracket closes.
    if (!/[}\]]/.test(piece)) return;
    const items = itemsSoFar(text).flatMap((i) => {
      const parsed = Item.safeParse(i);
      return parsed.success ? [parsed.data] : [];
    });
    const proposals = toProposals({ items, unclear: '' }, refs, me, today);
    for (; sent < proposals.length; sent++) onProposal(proposals[sent]!);
  };
}

// ---- the call -------------------------------------------------------------------------------

export interface SmartAddResult {
  proposals: Proposal[];
  unclear: string | null;
  usage: { inputTokens: number; outputTokens: number; ms: number };
}

export async function smartAdd(
  db: Db,
  ai: Ai,
  me: Member,
  input: { text: string; hints?: AddHints; effort?: Effort; timezone: string; onProposal?: (p: Proposal) => void },
): Promise<SmartAddResult> {
  const setup = requireAi(ai, db, input.timezone);
  const { text: context, refs, today } = buildContext(db, me, input.hints);
  const { output, usage, ms } = await ask(db, ai, {
    feature: 'smart_add',
    memberId: me.id,
    timezone: input.timezone,
    system: SYSTEM,
    content: `${context}\n\nWhat they typed:\n"""\n${input.text.trim()}\n"""`,
    schema: Output,
    effort: input.effort ?? (setup.effort === 'default' ? null : setup.effort),
    maxTokens: 16_000,
    ...(input.onProposal && { onText: proposalsAsWritten(refs, me, today, input.onProposal) }),
  });
  return {
    proposals: toProposals(output, refs, me, today),
    unclear: clean(output.unclear),
    usage: { inputTokens: usage.input + usage.cached, outputTokens: usage.output, ms },
  };
}

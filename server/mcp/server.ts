import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { and, count, eq, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import { describeRepeat, repeatOn } from '../../shared/repeat.ts';
import { listSections, listTemplate, LIST_TEMPLATES } from '../../shared/templates.ts';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { attachments, listItems, pushSubscriptions, tasks, type Group, type ListItem, type Member } from '../db/schema.ts';
import { createFileStore, type FileStore } from '../domain/files.ts';
import {
  createGroup,
  DomainError,
  firstName,
  GROUP_COLORS,
  GROUP_ICONS,
  listMembers,
  resolveGroup,
  resolveMember,
  visibleGroups,
  type Actor,
  type Assistant,
} from '../domain/household.ts';
import { addListItems, checkListItems, getListItems, openTrip, planTrip } from '../domain/lists.ts';
import { listEvents, type EventView } from '../domain/events.ts';
import { findGap, getLoad } from '../domain/load.ts';
import { daySuggestions, planWeek } from '../domain/planner.ts';
import { parseReminderTime } from '../domain/reminders.ts';
import { repeatSchema } from '../domain/repeat.ts';
import {
  archiveTasks,
  assignTask,
  completeTasks,
  createTasks,
  getTask,
  getToday,
  listTasks,
  moveTasks,
  skipTask,
  updateTask,
  type TaskDetail,
} from '../domain/tasks.ts';
import { addDays, planningDate, weekday } from '../lib/dates.ts';

const VERSION = '0.1.0';
const NOTES_PREVIEW = 160;
// The assistant can look at a photo up to this big (the app's smaller copy, usually), or read a text file.
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_MAX_BYTES = 200 * 1024;
const READABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Builds the Almanac MCP server acting as one member. Changes are logged as made via the
 * assistant on the other end: Claude for the local stdio connector, whichever app connected for
 * the remote one.
 */
export function createMcpServer({
  db,
  member,
  via = 'claude',
  files = createFileStore(config.dataDir),
}: {
  db: Db;
  member: Member;
  via?: Assistant;
  files?: FileStore;
}) {
  const actor: Actor = { member, via };
  const today = () => planningDate(member);

  const server = new McpServer(
    { name: 'almanac', title: 'Almanac', version: VERSION },
    { instructions: instructions(db, member) },
  );

  // ---- argument helpers -------------------------------------------------------------------

  const dateArg = z
    .string()
    .describe('YYYY-MM-DD, or "today" / "tomorrow"')
    .transform((value, ctx) => {
      const v = value.trim().toLowerCase();
      if (v === 'today') return today();
      if (v === 'tomorrow') return addDays(today(), 1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))) return v;
      ctx.addIssue({ code: 'custom', message: `"${value}" isn't a date. Use YYYY-MM-DD, "today" or "tomorrow".` });
      return z.NEVER;
    });
  const timeOfDay = z.enum(['morning', 'afternoon', 'evening']);
  const remindArg = z
    .string()
    .describe(`A phone notification for ${firstName(member)} at this local time (${member.timezone}), "YYYY-MM-DDTHH:MM". Only when they ask to be reminded.`);
  const who = z.string().describe('"me", a member\'s name or email, or "anyone" for a shared task');
  const ids = z.array(z.string()).min(1).max(100).describe('Task ids from earlier results');

  const groupId = (ref: string | null | undefined) =>
    ref == null ? (ref as null | undefined) : resolveGroup(db, member, ref, 'tasks').id;
  const memberId = (ref: string | undefined) => (ref === undefined ? undefined : (resolveMember(db, member, ref)?.id ?? null));
  const list = (ref: string | undefined): Group => {
    if (ref) return resolveGroup(db, member, ref, 'list');
    const first = visibleGroups(db, member.id).find((g) => g.kind === 'list');
    if (!first) throw new DomainError('There are no lists yet. Make one with create_group (kind "list").');
    return first;
  };

  // ---- result helpers ---------------------------------------------------------------------

  const present = (t: TaskDetail, full = false) =>
    compact({
      id: t.id.slice(0, 8),
      title: t.title,
      group: t.groupName,
      tripFor: t.listName ?? undefined,
      for: t.assigneeId ? (t.assigneeId === member.id ? 'me' : firstName({ name: t.assigneeName ?? '' })) : 'anyone',
      planned: t.plannedDate,
      due: t.dueDate,
      time: t.timeOfDay,
      mustDo: t.mustDo || undefined,
      estimateMinutes: t.estimateMinutes,
      status: t.status === 'open' ? undefined : t.status,
      notes: full || !t.notes || t.notes.length <= NOTES_PREVIEW ? t.notes : `${t.notes.slice(0, NOTES_PREVIEW)}…`,
      subtasks: t.subtasks.length ? t.subtasks.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.title}`) : undefined,
      links: t.links.length ? t.links.map((l) => (l.title ? `${l.title} <${l.url}>` : l.url)) : undefined,
      repeats: t.repeat
        ? describeRepeat(t.repeat, repeatOn(t.repeat) === 'due' ? t.dueDate : t.plannedDate, 'en-US') +
          (t.pausedUntil && t.pausedUntil > today() ? ` (paused until ${t.pausedUntil})` : '')
        : undefined,
      handedBackNote: t.handedBackNote,
      remindMe: t.reminder && !t.reminder.sentAt ? localDateTime(t.reminder.at, member.timezone) : undefined,
      files: t.files.length ? t.files.map((f) => `${f.name} (${f.mime}, ${Math.max(1, Math.round(f.size / 1024))} KB, id ${f.id.slice(0, 8)})`) : undefined,
    });
  const presentItem = (i: ListItem) =>
    compact({
      id: i.id.slice(0, 8),
      name: i.name,
      quantity: i.quantity,
      section: i.section,
      note: i.note,
      link: i.url,
      price: i.price,
      store: i.store,
      ingredients: i.parts ?? undefined,
      checked: i.checkedAt ? true : undefined,
    });

  type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
  const run =
    <A>(fn: (args: A) => unknown) =>
    async (args: A): Promise<Result> => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(fn(args)) }] };
      } catch (err) {
        if (err instanceof DomainError) return { isError: true, content: [{ type: 'text', text: err.message }] };
        console.error('Almanac tool failed:', err);
        return { isError: true, content: [{ type: 'text', text: 'Something went wrong in Almanac. Try again.' }] };
      }
    };

  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // ---- reading ----------------------------------------------------------------------------

  server.registerTool(
    'get_household',
    {
      title: 'Household overview',
      description: 'Who is in the household, every group and list with open counts, and today\'s date. Call this first if you need group names.',
      inputSchema: z.object({}),
      annotations: read,
    },
    run(() => {
      const openTasks = db
        .select({ groupId: tasks.groupId, n: count() })
        .from(tasks)
        .where(eq(tasks.status, 'open'))
        .groupBy(tasks.groupId)
        .all();
      const openItems = db
        .select({ groupId: listItems.groupId, n: count() })
        .from(listItems)
        .where(isNull(listItems.checkedAt))
        .groupBy(listItems.groupId)
        .all();
      return {
        today: today(),
        weekday: weekday(today()),
        you: member.name,
        members: listMembers(db).map((m) => (m.id === member.id ? `${m.name} (you)` : m.name)),
        groups: visibleGroups(db, member.id).map((g) =>
          compact({
            name: g.name,
            kind: g.kind,
            private: g.privateTo ? true : undefined,
            open: (g.kind === 'list' ? openItems : openTasks).find((r) => r.groupId === g.id)?.n ?? 0,
          }),
        ),
      };
    }),
  );

  server.registerTool(
    'get_today',
    {
      title: 'Today',
      description:
        "Today's day list: tasks planned for today, ones carried over from earlier days that weren't done, anything due by today that isn't planned, and what's already done today, plus how full the day is and what's on your calendar.",
      inputSchema: z.object({
        scope: z.enum(['mine', 'everyone']).optional().describe('"mine" (default) includes shared tasks; "everyone" adds other members\' tasks'),
      }),
      annotations: read,
    },
    run(({ scope }: { scope?: 'mine' | 'everyone' }) => {
      const t = getToday(db, member, scope === 'everyone' ? 'everyone' : member);
      const [load] = getLoad(db, member, member, t.today, t.today);
      return {
        today: t.today,
        weekday: weekday(t.today),
        load: compact({ level: load!.level, plannedMinutes: load!.plannedMinutes, roomMinutes: load!.capacityMinutes, calendarMinutes: load!.eventMinutes || undefined }),
        calendar: listEvents(db, member, t.today, t.today).map((e) => presentEvent(e, member.timezone)),
        planned: t.planned.map((x) => present(x)),
        carriedOver: t.carriedOver.map((x) => present(x)),
        dueNotPlanned: t.due.map((x) => present(x)),
        doneToday: t.done.map((x) => x.title),
      };
    }),
  );

  server.registerTool(
    'get_backlog',
    {
      title: 'Backlog',
      description: 'Open tasks sorted into their groups, most pressing first (must-do, then by due date).',
      inputSchema: z.object({
        group: z.string().optional().describe('Only this group'),
        for: who.optional().describe('Only tasks for this person: "me", a member\'s name, or "anyone" for shared tasks. Default: everyone\'s'),
        unplanned_only: z.boolean().optional().describe('Leave out tasks already planned for a day'),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: read,
    },
    run((a: { group?: string; for?: string; unplanned_only?: boolean; limit?: number }) => {
      const person = a.for === undefined ? undefined : resolveMember(db, member, a.for);
      const rows = listTasks(db, member, {
        groupId: groupId(a.group) ?? undefined,
        assignee: a.for === undefined ? undefined : person ? { memberId: person.id, includeShared: false } : 'unassigned',
        unplanned: a.unplanned_only,
        limit: a.limit ?? 200,
      });
      const byGroup = new Map<string, ReturnType<typeof present>[]>();
      for (const t of rows) {
        const key = t.groupName ?? 'No group';
        byGroup.set(key, [...(byGroup.get(key) ?? []), present(t)]);
      }
      return { today: today(), total: rows.length, groups: Object.fromEntries(byGroup) };
    }),
  );

  server.registerTool(
    'search_tasks',
    {
      title: 'Search tasks',
      description: 'Find tasks whose title or notes contain every word of the query.',
      inputSchema: z.object({
        query: z.string().min(1),
        status: z.enum(['open', 'done', 'all']).optional().describe('Default "open"'),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: read,
    },
    run((a: { query: string; status?: 'open' | 'done' | 'all'; limit?: number }) =>
      listTasks(db, member, { query: a.query, status: a.status ?? 'open', limit: a.limit ?? 25, order: a.status === 'done' ? 'recent' : 'backlog' }).map((t) => present(t)),
    ),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Task details',
      description: 'One task with its full notes, subtasks, links and files.',
      inputSchema: z.object({ id: z.string() }),
      annotations: read,
    },
    run(({ id }: { id: string }) => present(getTask(db, member, id), true)),
  );

  // ---- changing tasks ---------------------------------------------------------------------

  const newTask = z.object({
    title: z.string().min(1),
    notes: z.string().optional().describe('Markdown'),
    group: z.string().optional().describe('Group name, e.g. "Home"'),
    for: who.optional().describe('Who it\'s for: "me" (the default), a member\'s name or email, or "anyone" to share it'),
    due: dateArg.optional().describe('Deadline (YYYY-MM-DD, "today" or "tomorrow")'),
    planned: dateArg.optional().describe('Day to do it, which puts it on that day\'s list (YYYY-MM-DD, "today" or "tomorrow")'),
    time_of_day: timeOfDay.optional(),
    must_do: z.boolean().optional(),
    estimate_minutes: z.number().int().min(1).max(24 * 60).optional(),
    subtasks: z.array(z.string()).optional(),
    links: z.array(z.string()).optional().describe('URLs'),
    repeat: repeatSchema
      .optional()
      .describe(
        'Makes it repeat. Finishing one makes the next. "Every Sunday": {mode:"schedule",every:1,unit:"week",weekdays:[7]}. "1st of the month": {mode:"schedule",every:1,unit:"month",day:1}. "Furnace filter every 3 months": {mode:"after",every:3,unit:"month"}. Add months:[4,...,10] for seasonal ones.',
      ),
    remind_at: remindArg.optional(),
  });

  server.registerTool(
    'add_tasks',
    {
      title: 'Add tasks',
      description:
        'Add one or more tasks. Without a planned date a task goes to the backlog. Use add_to_list for shopping or packing items instead.',
      inputSchema: z.object({ tasks: z.array(newTask).min(1).max(50) }),
      annotations: write,
    },
    run(({ tasks: inputs }: { tasks: z.output<typeof newTask>[] }) =>
      createTasks(
        db,
        actor,
        inputs.map((t) => ({
          title: t.title,
          notes: t.notes,
          groupId: groupId(t.group),
          assigneeId: memberId(t.for),
          dueDate: t.due,
          plannedDate: t.planned,
          timeOfDay: t.time_of_day,
          mustDo: t.must_do,
          estimateMinutes: t.estimate_minutes,
          subtasks: t.subtasks,
          links: t.links?.map((url) => ({ url })),
          repeat: t.repeat,
          remindAt: t.remind_at ? parseReminderTime(t.remind_at, member.timezone) : undefined,
        })),
      ).map((t) => present(t)),
    ),
  );

  const patch = z.object({
    id: z.string(),
    title: z.string().min(1).optional(),
    notes: z.string().nullable().optional().describe('Replaces the notes; null clears them'),
    group: z.string().nullable().optional(),
    due: dateArg.nullable().optional().describe('null clears the deadline'),
    planned: dateArg.nullable().optional().describe('null moves it back to the backlog'),
    time_of_day: timeOfDay.nullable().optional(),
    must_do: z.boolean().optional(),
    estimate_minutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
    add_subtasks: z.array(z.string()).optional(),
    check_subtasks: z.array(z.string()).optional().describe('Subtask titles to mark done'),
    uncheck_subtasks: z.array(z.string()).optional(),
    add_links: z.array(z.string()).optional().describe('URLs'),
    remove_links: z.array(z.string()).optional().describe('URLs to remove'),
    repeat: repeatSchema.nullable().optional().describe('A new repeat rule (same shape as in add_tasks), or null to stop repeating'),
    paused_until: dateArg.nullable().optional().describe("A repeating task won't come back before this date; null ends the pause"),
    skip_next: z.boolean().optional().describe('Skip the next time this repeating task comes up, moving it to the date after'),
  });

  server.registerTool(
    'update_task',
    {
      title: 'Update a task',
      description:
        'Change any field of a task, tick subtasks, add and remove links, or change how it repeats. Only the fields you pass change.',
      inputSchema: patch,
      annotations: write,
    },
    run((a: z.output<typeof patch>) => {
      const updated = updateTask(db, actor, a.id, {
          title: a.title,
          notes: a.notes,
          groupId: groupId(a.group),
          dueDate: a.due,
          plannedDate: a.planned,
          timeOfDay: a.time_of_day,
          mustDo: a.must_do,
          estimateMinutes: a.estimate_minutes,
          addSubtasks: a.add_subtasks,
          checkSubtasks: a.check_subtasks,
          uncheckSubtasks: a.uncheck_subtasks,
          addLinks: a.add_links?.map((url) => ({ url })),
          removeLinks: a.remove_links,
          repeat: a.repeat,
          pausedUntil: a.paused_until,
        });
      return present(a.skip_next ? skipTask(db, actor, updated.id) : updated, true);
    }),
  );

  server.registerTool(
    'set_reminder',
    {
      title: 'Set a reminder',
      description: `Remind ${firstName(member)} about a task with one phone notification at a time they choose, or clear it with null. Only when they ask. Reminders are their own: nobody else sees them. A repeating task's reminder carries on to its next one.`,
      inputSchema: z.object({ id: z.string(), at: remindArg.nullable() }),
      annotations: { ...write, idempotentHint: true },
    },
    run((a: { id: string; at: string | null }) => {
      const task = updateTask(db, actor, a.id, { remindAt: a.at === null ? null : parseReminderTime(a.at, member.timezone) });
      const devices = db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.memberId, member.id)).get()?.n ?? 0;
      return {
        ...present(task),
        ...(a.at && !devices && { note: `${firstName(member)} hasn't turned on notifications on any device yet, so it can't reach them. They can in Almanac's Settings, under Notifications.` }),
      };
    }),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Look at a file',
      description: "Look at a photo or read a text file on a task, by the file id get_task lists. Other kinds of file (PDFs, documents) can't be opened here.",
      inputSchema: z.object({ id: z.string() }),
      annotations: read,
    },
    async ({ id }: { id: string }) => {
      const text = (t: string, isError = false) => ({ ...(isError && { isError: true }), content: [{ type: 'text' as const, text: t }] });
      const ref = id.trim().toLowerCase();
      if (!/^[0-9a-f-]{6,36}$/.test(ref)) return text(`"${id}" isn't a file id.`, true);
      const found = db
        .select()
        .from(attachments)
        .where(and(like(attachments.id, `${ref}%`), isNull(attachments.removedAt)))
        .limit(2)
        .all()
        .filter((f) => {
          try {
            getTask(db, member, f.taskId);
            return true;
          } catch {
            return false;
          }
        });
      if (found.length !== 1) return text(found.length ? 'More than one file starts with that id. Use more of it.' : `No file with id ${id}.`, true);
      const file = found[0]!;
      const sha = file.previewSha256 ?? file.sha256;
      const path = files.pathOf(sha);
      if (!fs.existsSync(path)) return text(`${file.name} is missing from the server.`, true);
      const size = fs.statSync(path).size;
      if (READABLE_IMAGES.has(file.mime) || file.previewSha256) {
        if (size > IMAGE_MAX_BYTES) return text(`${file.name} is too big to look at here (${Math.round(size / 1024 / 1024)} MB).`, true);
        const data = fs.readFileSync(path);
        const mimeType = file.previewSha256 ? sniffImage(data) : file.mime;
        return { content: [{ type: 'text' as const, text: file.name }, { type: 'image' as const, data: data.toString('base64'), mimeType }] };
      }
      if (file.mime.startsWith('text/') || file.mime === 'application/json') {
        if (size > TEXT_MAX_BYTES) return text(`${file.name} is too long to read here.`, true);
        return text(`${file.name}:\n\n${fs.readFileSync(path, 'utf8')}`);
      }
      return text(`${file.name} is a ${file.mime} file, which can't be opened through the connector. It's on the task in Almanac.`, true);
    },
  );

  server.registerTool(
    'complete_tasks',
    {
      title: 'Complete tasks',
      description: 'Mark tasks done. With undo, mark them open again. Finishing a repeating task makes its next one.',
      inputSchema: z.object({ ids, undo: z.boolean().optional() }),
      annotations: { ...write, idempotentHint: true },
    },
    run((a: { ids: string[]; undo?: boolean }) => completeTasks(db, actor, a.ids, !a.undo).map((t) => present(t))),
  );

  server.registerTool(
    'move_tasks',
    {
      title: 'Move tasks',
      description: "Put tasks on a day's list, or back in the backlog.",
      inputSchema: z.object({
        ids,
        to: z.string().describe('YYYY-MM-DD, "today", "tomorrow", or "backlog"'),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    run((a: { ids: string[]; to: string }) => {
      let target: string | null = null;
      if (a.to.trim().toLowerCase() !== 'backlog') {
        const parsed = dateArg.safeParse(a.to);
        if (!parsed.success) throw new DomainError(`"${a.to}" isn't a date. Use YYYY-MM-DD, "today", "tomorrow" or "backlog".`);
        target = parsed.data;
      }
      return moveTasks(db, actor, a.ids, target).map((t) => present(t));
    }),
  );

  server.registerTool(
    'assign_task',
    {
      title: 'Assign a task',
      description:
        'Hand a task to someone, or make it shared with "anyone". It lands quietly on their backlog with no notification. Add a note when handing something back.',
      inputSchema: z.object({ id: z.string(), to: who, note: z.string().optional() }),
      annotations: write,
    },
    run((a: { id: string; to: string; note?: string }) =>
      present(assignTask(db, actor, a.id, resolveMember(db, member, a.to)?.id ?? null, a.note)),
    ),
  );

  server.registerTool(
    'archive_tasks',
    {
      title: 'Remove tasks',
      description: 'Remove tasks that were added by mistake or no longer matter. They can be restored with restore: true.',
      inputSchema: z.object({ ids, restore: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    run((a: { ids: string[]; restore?: boolean }) => archiveTasks(db, actor, a.ids, a.restore).map((t) => present(t))),
  );

  // ---- lists ------------------------------------------------------------------------------

  const listArg = z.string().optional().describe('List name. Default: the first list (usually Groceries)');

  server.registerTool(
    'get_list',
    {
      title: 'Show a list',
      description:
        'What is still on a list (groceries, packing, gift ideas, a meal plan...), its sections, and its planned trip if it has one. Optionally include items checked off in the last 30 days.',
      inputSchema: z.object({ list: listArg, include_checked: z.boolean().optional() }),
      annotations: read,
    },
    run((a: { list?: string; include_checked?: boolean }) => {
      const group = list(a.list);
      const { open, checked } = getListItems(db, group, a.include_checked);
      const template = listTemplate(group.template);
      const sections = listSections(group, open.map((i) => i.section));
      const trip = template.trip ? openTrip(db, group) : null;
      return compact({
        list: group.name,
        kind: template.name,
        sections: sections.length ? `${template.sections?.label ?? 'Section'}: ${sections.join(', ')}` : undefined,
        newSectionsOk: template.sections?.free || undefined,
        items: open.map(presentItem),
        recentlyChecked: a.include_checked ? checked.map(presentItem) : undefined,
        trip: trip ? compact({ id: trip.id.slice(0, 8), title: trip.title, planned: trip.plannedDate }) : undefined,
      });
    }),
  );

  const item = z.object({
    name: z.string().min(1),
    quantity: z.string().optional().describe('e.g. "2", "1 lb"'),
    note: z.string().optional(),
    section: z
      .string()
      .optional()
      .describe('For lists with sections (get_list shows them): an aisle like "Produce", who a gift is for, a place. Groceries without one get a guessed aisle'),
    store: z.string().optional().describe('Where to buy it, on lists with stores'),
    link: z.string().optional(),
    price: z.string().optional(),
    ingredients: z.array(z.string()).optional().describe("A meal's ingredients, on a meal plan"),
  });

  server.registerTool(
    'add_to_list',
    {
      title: 'Add to a list',
      description: 'Add items to a list. Items already on it are updated instead of duplicated, and ones bought before come back.',
      inputSchema: z.object({ list: listArg, items: z.array(item).min(1).max(100) }),
      annotations: write,
    },
    run((a: { list?: string; items: z.output<typeof item>[] }) => {
      const group = list(a.list);
      const added = addListItems(
        db,
        actor,
        group,
        a.items.map(({ link, ingredients, ...it }) => ({ ...it, ...(link !== undefined && { url: link }), ...(ingredients !== undefined && { parts: ingredients }) })),
      );
      return { list: group.name, items: added.map(({ item: i, outcome }) => ({ ...presentItem(i), outcome })) };
    }),
  );

  server.registerTool(
    'check_off_list_items',
    {
      title: 'Check off list items',
      description: 'Check items off a list (bought, packed). With undo, put them back on.',
      inputSchema: z.object({ list: listArg, items: z.array(z.string()).min(1).describe('Item names or ids'), undo: z.boolean().optional() }),
      annotations: { ...write, idempotentHint: true },
    },
    run((a: { list?: string; items: string[]; undo?: boolean }) => {
      const group = list(a.list);
      return { list: group.name, [a.undo ? 'putBack' : 'checkedOff']: checkListItems(db, actor, group, a.items, !a.undo) };
    }),
  );

  server.registerTool(
    'plan_list_trip',
    {
      title: "Plan a list's trip",
      description:
        'Plan a whole list (Groceries, an errand run, the hardware store) as one task, like "Grocery run", on a day or in the backlog. Moves the trip if one is already planned. Check get_load first, as for any task.',
      inputSchema: z.object({ list: listArg, day: z.string().describe('YYYY-MM-DD, "today", "tomorrow", or "backlog"') }),
      annotations: { ...write, idempotentHint: true },
    },
    run((a: { list?: string; day: string }) => {
      let day: string | null = null;
      if (a.day.trim().toLowerCase() !== 'backlog') {
        const parsed = dateArg.safeParse(a.day);
        if (!parsed.success) throw new DomainError(`"${a.day}" isn't a date. Use YYYY-MM-DD, "today", "tomorrow" or "backlog".`);
        day = parsed.data;
      }
      const { task, created } = planTrip(db, actor, list(a.list), day);
      return { ...present(task), outcome: created ? 'planned' : 'moved' };
    }),
  );

  // ---- planning ---------------------------------------------------------------------------

  server.registerTool(
    'get_load',
    {
      title: 'Day load',
      description:
        "How full each day is: planned task minutes against the room that day has for tasks (capacityMinutes). Room is learned per person and weekday from what they actually finish (about 3 hours on weekdays and 4 on weekends to start; anyone can pin their own in Settings), then their Google Calendar adjusts it: busy time beyond a usual day for that weekday (usualEventMinutes) takes half its length off, and a lighter calendar gives some back. Tasks without an estimate count as 30 minutes. With include_events, your own events are listed per day (other people's calendars count but stay private).",
      inputSchema: z.object({
        start: dateArg.optional().describe('Default today'),
        end: dateArg.optional().describe('Default 6 days after start'),
        for: who.optional().describe('Whose days: "me" (the default) or a member\'s name'),
        include_events: z.boolean().optional().describe('List your own calendar events on each day'),
      }),
      annotations: read,
    },
    run((a: { start?: string; end?: string; for?: string; include_events?: boolean }) => {
      const person = (a.for && resolveMember(db, member, a.for)) || member;
      const start = a.start ?? today();
      const end = a.end ?? addDays(start, 6);
      const days = getLoad(db, member, person, start, end);
      if (!a.include_events || person.id !== member.id) return days;
      const events = listEvents(db, member, start, end);
      return days.map((d) => ({ ...d, calendar: events.filter((e) => onDate(e, d.date, member.timezone)).map((e) => presentEvent(e, member.timezone)) }));
    }),
  );

  server.registerTool(
    'find_gap',
    {
      title: 'Find a day for a task',
      description:
        'Suggest the lightest day between today and a due date that still has room for a task. It only suggests; use move_tasks or update_task to plan it.',
      inputSchema: z.object({
        due: dateArg,
        estimate_minutes: z.number().int().min(1).max(24 * 60).optional().describe('Default 30'),
        for: who.optional().describe('Whose days: "me" (the default) or a member\'s name'),
      }),
      annotations: read,
    },
    run((a: { due: string; estimate_minutes?: number; for?: string }) => {
      const person = (a.for && resolveMember(db, member, a.for)) || member;
      return findGap(db, member, person, a.due, a.estimate_minutes);
    }),
  );

  server.registerTool(
    'suggest_day',
    {
      title: 'Suggest what to do today',
      description:
        "A few backlog tasks worth pulling into today, best first, each with the planner's reason: deadlines first, then must-do, then what's waited longest, and only what fits in the room today has left (overdue and due-today ones always). The same suggestions the app's morning briefing shows. It only suggests; use move_tasks to plan one for today.",
      inputSchema: z.object({}),
      annotations: read,
    },
    run(() => {
      const t = today();
      const [load] = getLoad(db, member, member, t, t);
      return {
        today: t,
        roomLeftMinutes: Math.max(load!.capacityMinutes - load!.plannedMinutes, 0),
        suggestions: daySuggestions(db, member).map((x) => ({ ...present(x.task), reason: x.reason, fits: x.fits })),
      };
    }),
  );

  server.registerTool(
    'plan_week',
    {
      title: 'Plan the week',
      description:
        "A draft plan for the next seven days: anything left over from earlier days and the most pressing backlog tasks, each on the day with the most room, filling days to about 85% and never past a deadline. Tasks that don't fit stay in the backlog. It only suggests: show the plan, adjust it with the person, then use move_tasks for what they agree to.",
      inputSchema: z.object({}),
      annotations: read,
    },
    run(() => {
      const plan = planWeek(db, member);
      return {
        days: plan.days.map((d) => ({ date: d.date, weekday: d.weekday, plannedMinutes: d.plannedMinutes, roomMinutes: d.capacityMinutes, level: d.level })),
        plan: plan.picks.map((p) => ({ ...present(p.task), day: p.date, weekday: p.weekday, reason: p.reason, fits: p.fits })),
      };
    }),
  );

  // ---- groups -----------------------------------------------------------------------------

  server.registerTool(
    'create_group',
    {
      title: 'Create a group or list',
      description: 'Make a new task group, or a list (kind "list") for shopping-style items.',
      inputSchema: z.object({
        name: z.string().min(1),
        kind: z.enum(['tasks', 'list']).optional().describe('Default "tasks"'),
        icon: z.enum(GROUP_ICONS).optional(),
        color: z.enum(GROUP_COLORS).optional(),
        template: z
          .enum(LIST_TEMPLATES.map((t) => t.id) as [string, ...string[]])
          .optional()
          .describe(`Lists only: ${LIST_TEMPLATES.map((t) => `"${t.id}" (${t.description})`).join('; ')}`),
        kit: z
          .string()
          .optional()
          .describe(
            `Lists only: starter items to fill it with, by name, or "none". ${LIST_TEMPLATES.filter((t) => t.kits)
              .map((t) => `${t.id}: ${t.kits!.map((k) => k.name).join(', ')} (default ${t.kits![0]!.name})`)
              .join('; ')}`,
          ),
        private: z.boolean().optional().describe('Only you can see it and its tasks. Gift ideas lists are private unless you say false'),
      }),
      annotations: write,
    },
    run((a: { name: string; kind?: 'tasks' | 'list'; icon?: (typeof GROUP_ICONS)[number]; color?: (typeof GROUP_COLORS)[number]; private?: boolean; template?: string; kit?: string }) => {
      const g = createGroup(db, actor, { ...a, kit: a.kit?.trim().toLowerCase() === 'none' ? null : a.kit });
      return compact({ name: g.name, kind: g.kind, icon: g.icon, color: g.color, private: g.privateTo ? true : undefined });
    }),
  );

  return server;
}

function instructions(db: Db, member: Member) {
  const today = planningDate(member);
  const others = listMembers(db).filter((m) => m.id !== member.id);
  const groups = visibleGroups(db, member.id);
  const names = (kind: Group['kind']) =>
    groups
      .filter((g) => g.kind === kind)
      .map((g) => g.name)
      .join(', ') || 'none yet';
  const me = firstName(member);
  return `Almanac is a calm, shared household planner. You're acting for ${member.name}${others.length ? `, who shares it with ${others.map((m) => m.name).join(' and ')}` : ''}. For ${me}, today is ${weekday(today)} ${today}; the day turns over at ${member.dayCutoffHour}am (${member.timezone}).

How it fits together:
- Tasks live in groups (${names('tasks')}). Lists (${names('list')}) hold shopping-style items: use add_to_list for those, not add_tasks.
- "planned" is the day someone means to do a task, which puts it on that day's list. "due" is a real deadline. A task with no planned date sits in the backlog.
- New tasks are for ${me} unless you say otherwise; "anyone" makes a task shared. Assigning to someone else puts it on their backlog quietly.
- Almanac's only notifications are reminders someone asks for ("remind me Thursday at 6"): set_reminder, or remind_at on add_tasks. One notification at that time, to ${me} only. Never add one they didn't ask for.
- Tasks can have files (photos, receipts, manuals). get_task lists them; read_file shows you a photo or a text file.
- Almanac is deliberately calm. Don't schedule everything: keep each day light, check get_load before adding to a day, and use find_gap for things due later. suggest_day and plan_week give the planner's own picks with reasons.
- Day load counts each person's Google Calendar once they've connected it in Settings: a day with more on the calendar than usual has less room for tasks.
- Ids in results are short prefixes. Pass them back exactly as given.`;
}

/** A moment as the person's local date and time: "2026-10-16T18:00". */
const localDateTime = (at: Date, timeZone: string) =>
  Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: 'minute' });

/** What kind of image some bytes are: the app's smaller copies are WebP, or JPEG from Safari. */
function sniffImage(data: Buffer) {
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  return 'image/jpeg';
}

const localDate = (iso: string, timeZone: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone).toPlainDate().toString();
const localTime = (iso: string, timeZone: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

function onDate(e: EventView, date: string, timeZone: string) {
  if (e.allDay) return e.startDate! <= date && date < e.endDate!;
  return localDate(e.start, timeZone) <= date && date <= localDate(e.end, timeZone);
}

/** An event in local time, short: "09:00-10:00 Dentist", or all day. */
function presentEvent(e: EventView, timeZone: string) {
  return compact({
    title: e.title ?? 'Busy',
    when: e.allDay ? 'all day' : `${localTime(e.start, timeZone)}-${localTime(e.end, timeZone)}`,
    free: e.busy ? undefined : true,
    calendar: e.calendar,
  });
}

/** Drops null, undefined and empty values so results stay short. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== '')) as Partial<T>;
}

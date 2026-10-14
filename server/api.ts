// The app's JSON API over the task layer. Every route here runs behind the sign-in guard and
// logs changes as made "via app".
import { count, eq, isNull } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AddHints, Proposal } from '../shared/proposals.ts';
import { applyProposals } from './ai/apply.ts';
import { AiUnavailable, monthSpendUsd, type Ai } from './ai/client.ts';
import { smartAdd } from './ai/smartAdd.ts';
import { inviteMember } from './auth/members.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { listItems, members, tasks, type Member } from './db/schema.ts';
import type { Env } from './env.ts';
import { listActivity } from './domain/activity.ts';
import {
  archiveGroup,
  archivedGroups,
  createGroup,
  DomainError,
  GROUP_COLORS,
  GROUP_ICONS,
  listMembers,
  reorderGroups,
  resolveGroup,
  resolveMember,
  updateGroup,
  visibleGroups,
  type Actor,
} from './domain/household.ts';
import { addListItems, checkListItems, getListItems, listHistory, resetList, updateListItem } from './domain/lists.ts';
import { defaultCapacity, getLoad, learnedCapacity } from './domain/load.ts';
import { repeatSchema } from './domain/repeat.ts';
import { getStats } from './domain/stats.ts';
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
} from './domain/tasks.ts';
import { addDays, planningDate } from './lib/dates.ts';

const date = z.iso.date();
const timeOfDay = z.enum(['morning', 'afternoon', 'evening']);
const link = z.object({ url: z.string().max(2000), title: z.string().max(300).nullable().optional() });

const newTask = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(20_000).nullable().optional(),
  groupId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: date.nullable().optional(),
  plannedDate: date.nullable().optional(),
  timeOfDay: timeOfDay.nullable().optional(),
  mustDo: z.boolean().optional(),
  estimateMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  subtasks: z.array(z.string().max(300)).max(50).optional(),
  links: z.array(link).max(20).optional(),
  repeat: repeatSchema.nullable().optional(),
});

const taskPatch = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  notes: z.string().max(20_000).nullable().optional(),
  groupId: z.string().nullable().optional(),
  dueDate: date.nullable().optional(),
  plannedDate: date.nullable().optional(),
  timeOfDay: timeOfDay.nullable().optional(),
  mustDo: z.boolean().optional(),
  estimateMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  addSubtasks: z.array(z.string().max(300)).max(50).optional(),
  checkSubtasks: z.array(z.string()).optional(),
  uncheckSubtasks: z.array(z.string()).optional(),
  removeSubtasks: z.array(z.string()).optional(),
  addLinks: z.array(link).max(20).optional(),
  removeLinks: z.array(z.string()).optional(),
  repeat: repeatSchema.nullable().optional(),
  pausedUntil: date.nullable().optional(),
});

/** Parses a JSON body, answering 400 with a readable message when it doesn't fit. */
async function body<T extends z.ZodType>(c: Context<Env>, schema: T): Promise<z.output<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new DomainError(`That request doesn't look right: ${z.prettifyError(parsed.error).split('\n')[0]}`);
  return parsed.data;
}

const proposedTask = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(20_000).nullable(),
  groupId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  plannedDate: date.nullable(),
  dueDate: date.nullable(),
  timeOfDay: timeOfDay.nullable(),
  mustDo: z.boolean(),
  estimateMinutes: z.number().int().min(1).max(1440).nullable(),
  estimateSource: z.enum(['ai', 'user']),
  subtasks: z.array(z.string().max(300)).max(50),
  links: z.array(z.string().max(2000)).max(20),
  repeat: repeatSchema.nullable(),
});

const proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), task: proposedTask }),
  z.object({
    kind: z.literal('list_item'),
    listId: z.string(),
    name: z.string().trim().min(1).max(200),
    quantity: z.string().max(40).nullable(),
    section: z.string().max(60).nullable(),
    note: z.string().max(300).nullable(),
  }),
  z.object({
    kind: z.literal('update'),
    taskId: z.string(),
    title: z.string(),
    changes: z.object({
      title: z.string().trim().min(1).max(500).optional(),
      notes: z.string().max(20_000).nullable().optional(),
      groupId: z.string().nullable().optional(),
      assigneeId: z.string().nullable().optional(),
      plannedDate: date.nullable().optional(),
      dueDate: date.nullable().optional(),
      timeOfDay: timeOfDay.nullable().optional(),
      mustDo: z.boolean().optional(),
      estimateMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      addSubtasks: z.array(z.string().max(300)).max(50).optional(),
      repeat: repeatSchema.nullable().optional(),
    }),
  }),
  z.object({ kind: z.literal('complete'), taskId: z.string(), title: z.string() }),
  z.object({ kind: z.literal('check'), listId: z.string(), itemId: z.string(), name: z.string() }),
]);

const addHints = z.object({
  plannedDate: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  groupId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  timeOfDay: timeOfDay.nullable().optional(),
  mustDo: z.boolean().optional(),
  explicit: z.array(z.enum(['plannedDate', 'dueDate', 'groupId', 'assigneeId', 'timeOfDay', 'mustDo'])).optional(),
});

const listItemFields = {
  quantity: z.string().max(40).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  section: z.string().max(60).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  price: z.string().max(40).nullable().optional(),
};

export function registerApi(app: Hono<Env>, { db, config, ai }: { db: Db; config: Config; ai: Ai }) {
  const me = (c: Context<Env>) => c.get('member')!;
  const actor = (c: Context<Env>): Actor => ({ member: me(c), via: 'app' });
  // Group and member ids come from the app, but still have to be ones this member can use.
  const groupId = (m: Member, id: string | null | undefined) => (id == null ? id : resolveGroup(db, m, id, 'tasks').id);
  const memberId = (m: Member, id: string | null | undefined) => (id == null ? id : resolveMember(db, m, id)?.id ?? null);
  // Whose day or calendar: "me" (the default), "everyone", or a member id.
  const whose = (viewer: Member, who: string | undefined): Member | 'everyone' =>
    !who || who === 'me' ? viewer : who === 'everyone' ? 'everyone' : (resolveMember(db, viewer, who) ?? viewer);

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, 400);
    console.error('Request failed:', err);
    return c.json({ error: 'Something went wrong. Try again.' }, 500);
  });

  // ---- household ----------------------------------------------------------------------------

  app.get('/api/members', (c) => {
    const all = listMembers(db);
    const known = new Set(all.map((m) => m.email));
    return c.json({
      members: all.map(({ id, name, email, color, avatarUrl, role, lastLoginAt }) => ({
        id,
        name,
        email,
        color,
        avatarUrl,
        role,
        signedIn: lastLoginAt != null,
      })),
      // Allowed by the server's settings but not in the household yet; admins can add them.
      pending: me(c).role === 'admin' ? config.allowedEmails.filter((e) => !known.has(e)) : [],
    });
  });

  app.post('/api/members', async (c) => {
    if (me(c).role !== 'admin') return c.json({ error: 'Only an admin can add people.' }, 403);
    const input = await body(c, z.object({ email: z.email().max(320), name: z.string().trim().min(1).max(80) }));
    if (db.select().from(members).where(eq(members.email, input.email.toLowerCase())).get()) {
      throw new DomainError('That person is already in the household.');
    }
    return c.json({ member: inviteMember(db, config, input) }, 201);
  });

  app.patch('/api/members/:id', async (c) => {
    const id = c.req.param('id');
    if (me(c).role !== 'admin' && me(c).id !== id) return c.json({ error: 'You can only rename yourself.' }, 403);
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    const member = db.update(members).set({ name }).where(eq(members.id, id)).returning().get();
    return member ? c.json({ member }) : c.json({ error: 'Not found.' }, 404);
  });

  app.delete('/api/members/:id', (c) => {
    const target = db.select().from(members).where(eq(members.id, c.req.param('id'))).get();
    if (me(c).role !== 'admin') return c.json({ error: 'Only an admin can remove people.' }, 403);
    if (!target) return c.json({ error: 'Not found.' }, 404);
    if (target.id === me(c).id || target.role === 'admin') throw new DomainError("Admins can't be removed here.");
    // Their sessions and Claude connections go with them; their tasks stay, unassigned.
    db.delete(members).where(eq(members.id, target.id)).run();
    return c.body(null, 204);
  });

  // ---- groups -------------------------------------------------------------------------------

  app.get('/api/groups', (c) => {
    if (c.req.query('archived') === '1') return c.json({ groups: archivedGroups(db, me(c).id).map((g) => ({ ...g, open: 0 })) });
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
    const groups = visibleGroups(db, me(c).id).map((g) => ({
      ...g,
      open: (g.kind === 'list' ? openItems : openTasks).find((r) => r.groupId === g.id)?.n ?? 0,
    }));
    return c.json({ groups });
  });

  app.post('/api/groups', async (c) => {
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60),
        kind: z.enum(['tasks', 'list']).optional(),
        icon: z.enum(GROUP_ICONS).optional(),
        color: z.enum(GROUP_COLORS).optional(),
        private: z.boolean().optional(),
        template: z.string().max(40).optional(),
      }),
    );
    return c.json({ group: createGroup(db, actor(c), input) }, 201);
  });

  app.patch('/api/groups/:id', async (c) => {
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        icon: z.enum(GROUP_ICONS).optional(),
        color: z.enum(GROUP_COLORS).optional(),
      }),
    );
    return c.json({ group: updateGroup(db, actor(c), c.req.param('id'), input) });
  });

  app.post('/api/groups/order', async (c) => {
    const { ids } = await body(c, z.object({ ids: z.array(z.string()).max(200) }));
    reorderGroups(db, me(c), ids);
    return c.body(null, 204);
  });

  app.post('/api/groups/:id/archive', async (c) => {
    const { restore } = await body(c, z.object({ restore: z.boolean().optional() }));
    return c.json({ group: archiveGroup(db, actor(c), c.req.param('id'), restore) });
  });

  // ---- tasks --------------------------------------------------------------------------------

  app.get('/api/today', (c) => {
    const viewer = me(c);
    const person = whose(viewer, c.req.query('who'));
    const day = getToday(db, viewer, person);
    const [load] = getLoad(db, viewer, person === 'everyone' ? viewer : person, day.today, day.today);
    return c.json({ ...day, load });
  });

  app.get('/api/load', (c) => {
    const viewer = me(c);
    const start = date.safeParse(c.req.query('start')).data ?? planningDate(viewer);
    const end = date.safeParse(c.req.query('end')).data ?? addDays(start, 6);
    // Everyone's calendar shows the viewer's own load, like Today does.
    const person = whose(viewer, c.req.query('who'));
    return c.json({ days: getLoad(db, viewer, person === 'everyone' ? viewer : person, start, end) });
  });

  // What Almanac has learned about the viewer's capacity, next to the defaults and their pins.
  app.get('/api/capacity', (c) => {
    const m = me(c);
    const days = learnedCapacity(db, m).map((d) => ({ ...d, default: defaultCapacity(d.weekday), pinned: m.capacity?.[String(d.weekday)] ?? null }));
    return c.json({ days });
  });

  app.get('/api/tasks', (c) => {
    const q = c.req.query();
    const viewer = me(c);
    const status = q.status === 'done' || q.status === 'all' ? q.status : 'open';
    // `who` matches Today (their tasks plus shared ones); `assignee` is exact.
    const person = q.who ? whose(viewer, q.who) : undefined;
    const tasks = listTasks(db, viewer, {
      status,
      groupId: q.group || undefined,
      query: q.q || undefined,
      unplanned: q.unplanned === '1',
      plannedFrom: date.safeParse(q.from).data,
      plannedTo: date.safeParse(q.to).data,
      assignee:
        person && person !== 'everyone'
          ? { memberId: person.id, includeShared: true }
          : q.assignee === 'unassigned'
            ? 'unassigned'
            : q.assignee
              ? { memberId: q.assignee, includeShared: false }
              : undefined,
      order: status === 'done' ? 'recent' : 'backlog',
      limit: Math.min(Number(q.limit) || 500, 1000),
    });
    return c.json({ tasks });
  });

  app.post('/api/tasks', async (c) => {
    const input = await body(c, newTask);
    const viewer = me(c);
    const [task] = createTasks(db, actor(c), [
      { ...input, groupId: groupId(viewer, input.groupId), assigneeId: memberId(viewer, input.assigneeId) },
    ]);
    return c.json({ task }, 201);
  });

  app.get('/api/tasks/:id', (c) => c.json({ task: getTask(db, me(c), c.req.param('id')) }));

  app.get('/api/tasks/:id/activity', (c) => {
    const task = getTask(db, me(c), c.req.param('id'));
    return c.json(listActivity(db, me(c), { taskId: task.id, limit: 100 }));
  });

  // ---- activity and stats -------------------------------------------------------------------

  app.get('/api/activity', (c) => {
    const limit = Number(c.req.query('limit')) || undefined;
    return c.json(listActivity(db, me(c), { before: c.req.query('before') || undefined, limit }));
  });

  app.get('/api/stats', (c) => {
    const weeks = Number(c.req.query('weeks')) || undefined;
    const weekStart = Number(c.req.query('weekStart')) || undefined;
    return c.json(getStats(db, me(c), { weeks, weekStart }));
  });

  app.patch('/api/tasks/:id', async (c) => {
    const input = await body(c, taskPatch);
    const task = updateTask(db, actor(c), c.req.param('id'), { ...input, groupId: groupId(me(c), input.groupId) });
    return c.json({ task });
  });

  app.post('/api/tasks/:id/complete', async (c) => {
    const { done } = await body(c, z.object({ done: z.boolean() }));
    const [task] = completeTasks(db, actor(c), [c.req.param('id')], done);
    return c.json({ task });
  });

  app.post('/api/tasks/:id/skip', (c) => c.json({ task: skipTask(db, actor(c), c.req.param('id')) }));

  app.post('/api/tasks/:id/move', async (c) => {
    const { plannedDate, timeOfDay: time } = await body(c, z.object({ plannedDate: date.nullable(), timeOfDay: timeOfDay.nullable().optional() }));
    let [task] = moveTasks(db, actor(c), [c.req.param('id')], plannedDate);
    if (time !== undefined) task = updateTask(db, actor(c), task!.id, { timeOfDay: time });
    return c.json({ task });
  });

  app.post('/api/tasks/:id/assign', async (c) => {
    const input = await body(c, z.object({ assigneeId: z.string().nullable(), note: z.string().max(500).nullable().optional() }));
    const task = assignTask(db, actor(c), c.req.param('id'), memberId(me(c), input.assigneeId) ?? null, input.note);
    return c.json({ task });
  });

  app.post('/api/tasks/:id/archive', async (c) => {
    const { restore } = await body(c, z.object({ restore: z.boolean().optional() }));
    const [task] = archiveTasks(db, actor(c), [c.req.param('id')], restore);
    return c.json({ task });
  });

  // ---- lists --------------------------------------------------------------------------------

  app.get('/api/lists/:groupId', (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    return c.json({ group, ...getListItems(db, group, true) });
  });

  app.post('/api/lists/:groupId/items', async (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(200), ...listItemFields }));
    const [added] = addListItems(db, actor(c), group, [input]);
    return c.json(added, 201);
  });

  app.patch('/api/lists/:groupId/items/:itemId', async (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(200).optional(), ...listItemFields }));
    return c.json({ item: updateListItem(db, actor(c), group, c.req.param('itemId'), input) });
  });

  app.get('/api/lists/:groupId/history', (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    return c.json({ items: listHistory(db, group) });
  });

  app.post('/api/lists/:groupId/reset', (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    return c.json({ reset: resetList(db, actor(c), group) });
  });

  // ---- smart add ----------------------------------------------------------------------------

  app.get('/api/ai', (c) =>
    c.json({
      available: ai.available,
      smartAdd: ai.available && me(c).smartAdd,
      model: ai.model,
      effort: ai.effort,
      monthSpendUsd: Math.round(monthSpendUsd(db, config.timezone) * 100) / 100,
      monthlyCapUsd: ai.monthlyCapUsd,
    }),
  );

  // Proposals to review, or { fallback } when Haiku can't help and the app should add it as typed.
  app.post('/api/smart-add', async (c) => {
    const input = await body(c, z.object({ text: z.string().trim().min(1).max(4000), hints: addHints.optional() }));
    if (!me(c).smartAdd) return c.json({ fallback: 'Smart add is off in your settings.' });
    try {
      return c.json(await smartAdd(db, ai, me(c), { text: input.text, hints: input.hints as AddHints, timezone: config.timezone }));
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      console.warn('Smart add fell back:', err.message);
      return c.json({ fallback: err.message });
    }
  });

  app.post('/api/smart-add/apply', async (c) => {
    const { proposals } = await body(c, z.object({ proposals: z.array(proposal).min(1).max(100) }));
    return c.json(applyProposals(db, actor(c), proposals as Proposal[]));
  });

  app.post('/api/lists/:groupId/items/:itemId/check', async (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    const { checked } = await body(c, z.object({ checked: z.boolean() }));
    checkListItems(db, actor(c), group, [c.req.param('itemId')], checked);
    return c.body(null, 204);
  });
}

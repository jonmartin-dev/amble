// The app's JSON API over the task layer. Every route here runs behind the sign-in guard and
// logs changes as made "via app".
import { count, eq, isNull } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AddHints, Proposal } from '../shared/proposals.ts';
import { applyOrganize, applyProposals } from './ai/apply.ts';
import { organizeBacklog, planMyWeek, type OrganizeSuggestion } from './ai/plan.ts';
import { AiUnavailable, modelName, type Ai } from './ai/client.ts';
import { aiSettingsInput, aiView, saveAiSettings } from './ai/settings.ts';
import { smartAdd } from './ai/smartAdd.ts';
import { inviteMember } from './auth/members.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { listItems, members, tasks, type Attachment, type Member } from './db/schema.ts';
import type { Env } from './env.ts';
import { listActivity } from './domain/activity.ts';
import { listPhoneCalendars, savePhoneCalendars, savePhoneEvents, setCalendarCounts, sharedBusyDays, stopPhoneCalendars } from './domain/calendars.ts';
import { listEvents } from './domain/events.ts';
import {
  addAttachment,
  cleanName,
  fileType,
  FileTooBig,
  getAttachment,
  removeAttachment,
  servedAs,
  setPreview,
  tooBigMessage,
  type FileStore,
} from './domain/files.ts';
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
import { addListItems, checkListItems, getListItems, listHistory, openTrip, resetList, setListSections, updateListItem } from './domain/lists.ts';
import { defaultCapacity, findGap, getLoad, learnedCapacity, MAX_CAPACITY_MINUTES } from './domain/load.ts';
import { dismissSuggestion, findGaps, getBriefing, markBriefingSeen } from './domain/planner.ts';
import { snoozeReminder, upcomingReminders } from './domain/reminders.ts';
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
import type { Push } from './notify/devices.ts';
import { reminderBody } from './notify/reminders.ts';
import { madeAt } from './requests.ts';

const date = z.iso.date();
// A moment, as the app's toISOString() gives it.
const instant = z.iso.datetime({ offset: true });
const timeOfDay = z.enum(['morning', 'afternoon', 'evening']);
const link = z.object({ id: z.uuid().optional(), url: z.string().max(2000), title: z.string().max(300).nullable().optional() });
// A step's title, or an id and title when the app made it offline and may change it before it syncs.
const newSubtask = z.union([z.string().max(300), z.object({ id: z.uuid(), title: z.string().max(300) })]);

const newTask = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(20_000).nullable().optional(),
  groupId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: date.nullable().optional(),
  plannedDate: date.nullable().optional(),
  timeOfDay: timeOfDay.nullable().optional(),
  mustDo: z.boolean().optional(),
  estimateMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  subtasks: z.array(newSubtask).max(50).optional(),
  links: z.array(link).max(20).optional(),
  repeat: repeatSchema.nullable().optional(),
  remindAt: instant.nullable().optional(),
  listId: z.string().nullable().optional(),
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
  addSubtasks: z.array(newSubtask).max(50).optional(),
  checkSubtasks: z.array(z.string()).optional(),
  uncheckSubtasks: z.array(z.string()).optional(),
  removeSubtasks: z.array(z.string()).optional(),
  addLinks: z.array(link).max(20).optional(),
  removeLinks: z.array(z.string()).optional(),
  repeat: repeatSchema.nullable().optional(),
  pausedUntil: date.nullable().optional(),
  remindAt: instant.nullable().optional(),
});

/** A reminder time from the app as a Date; null clears it and undefined leaves it alone. */
const when = (value: string | null | undefined) => (value == null ? value : new Date(value));

// The smaller copy of a photo the app makes when adding it.
const PREVIEW_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
const PREVIEW_MAX_BYTES = 3 * 1024 * 1024;

/** What kind of image a preview is, from its first bytes. */
export function imageType(bytes: Uint8Array) {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  return 'image/jpeg';
}

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
  remindAt: instant.nullable().optional(),
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
    store: z.string().max(60).nullable().optional(),
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
      remindAt: instant.nullable().optional(),
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
  store: z.string().max(60).nullable().optional(),
  parts: z.array(z.string().max(200)).max(50).nullable().optional(),
};

// The phone's calendars and their events, as the Android app reads them.
const phoneCalendar = z.object({
  id: z.string().min(1).max(200),
  account: z.string().max(300).nullish().default(null),
  name: z.string().max(300),
  color: z.string().max(20).nullish().default(null),
  primary: z.boolean(),
  writable: z.boolean(),
  visible: z.boolean(),
});
const phoneEvent = z.object({
  id: z.string().min(1).max(300),
  calendarId: z.string().min(1).max(200),
  uid: z.string().max(500).nullish().default(null),
  title: z.string().max(1000).nullish().default(null),
  begin: z.number(),
  end: z.number(),
  allDay: z.boolean(),
  busy: z.boolean(),
});

export function registerApi(
  app: Hono<Env>,
  { db, config, ai, push, files }: { db: Db; config: Config; ai: Ai; push: Push; files: FileStore },
) {
  const me = (c: Context<Env>) => c.get('member')!;
  // A change the app queued offline says how long ago it was made.
  const actor = (c: Context<Env>): Actor => {
    const at = madeAt(c.req.header('almanac-age'));
    return { member: me(c), via: 'app', ...(at && { at }) };
  };
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

  const themeSchema = z.object({
    mode: z.enum(['system', 'light', 'dark']),
    seed: z.string().regex(/^#[0-9a-f]{6}$/i),
    style: z.enum(['tonal', 'expressive', 'vibrant', 'fidelity', 'neutral']),
    contrast: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
    phone: z.boolean().optional(),
  });

  // ---- you ----------------------------------------------------------------------------------

  app.patch('/api/me', async (c) => {
    // theme: null resets to the default theme.
    // capacity: null resets every weekday to the default; a missing weekday uses the default too.
    const parsed = z
      .object({
        theme: themeSchema.nullable().optional(),
        capacity: z
          .partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.number().int().min(0).max(MAX_CAPACITY_MINUTES))
          .nullable()
          .optional(),
        showStreaks: z.boolean().optional(),
        smartAdd: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Those settings look wrong. Try again.' }, 400);
    const me = c.get('member')!;
    const { theme, capacity, showStreaks, smartAdd } = parsed.data;
    const updated = db
      .update(members)
      .set({
        ...(theme !== undefined && { theme }),
        ...(capacity !== undefined && { capacity }),
        ...(showStreaks !== undefined && { showStreaks }),
        ...(smartAdd !== undefined && { smartAdd }),
      })
      .where(eq(members.id, me.id))
      .returning()
      .get();
    return c.json({ member: updated });
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
    // Their sessions and assistant connections go with them; their tasks stay, unassigned.
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
        kit: z.string().max(60).nullable().optional(),
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

  // What Amble has learned about the viewer's capacity, next to the defaults and their pins.
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
      {
        ...input,
        groupId: groupId(viewer, input.groupId),
        assigneeId: memberId(viewer, input.assigneeId),
        remindAt: when(input.remindAt),
        listId: input.listId == null ? input.listId : resolveGroup(db, viewer, input.listId, 'list').id,
      },
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
    const task = updateTask(db, actor(c), c.req.param('id'), { ...input, groupId: groupId(me(c), input.groupId), remindAt: when(input.remindAt) });
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

  // ---- reminders and notifications ----------------------------------------------------------

  // The key the app subscribes with, and the devices where this person turned notifications on.
  app.get('/api/push', (c) => c.json({ publicKey: push.publicKey, devices: push.devices(me(c)) }));

  app.post('/api/push/subscriptions', async (c) => {
    const sub = await body(
      c,
      z.object({ endpoint: z.string().max(2000), keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }) }),
    );
    push.subscribe(me(c), sub, c.req.header('user-agent'));
    return c.body(null, 204);
  });

  app.post('/api/push/unsubscribe', async (c) => {
    const { endpoint } = await body(c, z.object({ endpoint: z.string().max(2000) }));
    push.unsubscribe(me(c), endpoint);
    return c.body(null, 204);
  });

  app.delete('/api/push/devices/:id', (c) => {
    push.removeDevice(me(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/api/push/test', async (c) => {
    const result = await push.sendTo(me(c).id, {
      title: 'Notifications are on',
      body: "This is how Amble's reminders will look.",
      tag: 'amble-test',
      url: `${config.basePath}/settings/notifications`,
    });
    return c.json(result);
  });

  // With the line each notification shows, for the Android app, which schedules them ahead.
  app.get('/api/reminders', (c) => {
    const member = me(c);
    const upcoming = upcomingReminders(db, member).map(({ dueDate, notes, ...r }) => ({ ...r, body: reminderBody({ dueDate, notes }, member, r.at) ?? null }));
    return c.json({ reminders: upcoming });
  });

  app.post('/api/reminders/:id/snooze', async (c) => {
    const { minutes } = await body(c, z.object({ minutes: z.number().int().min(5).max(7 * 24 * 60) }));
    const taskId = snoozeReminder(db, me(c), c.req.param('id'), minutes);
    return c.json({ task: getTask(db, me(c), taskId) });
  });

  // ---- files --------------------------------------------------------------------------------

  /** A file on a task this person can see, or null. */
  const visibleFile = (c: Context<Env>): Attachment | null => {
    const file = getAttachment(db, c.req.param('id') ?? '');
    if (!file) return null;
    try {
      getTask(db, me(c), file.taskId);
    } catch {
      return null;
    }
    return file;
  };
  const gone = (c: Context<Env>) => c.json({ error: 'That file is gone.' }, 404);
  const tooBig = () => tooBigMessage(config.maxFileBytes);

  /** Streams stored bytes back. They never change, so browsers can keep them. */
  const sendFile = async (c: Context<Env>, sha256: string, kind: string | ((bytes: Uint8Array) => string), inline: boolean, name: string) => {
    const file = await files.get(sha256);
    if (!file) return gone(c);
    if (c.req.header('if-none-match') === `"${sha256}"`) return c.body(null, 304);
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    // A preview's type comes from its first bytes.
    const type = typeof kind === 'function' ? kind(await file.bytes()) : kind;
    return c.body(file.stream(), 200, {
      'Content-Type': type,
      'Content-Length': String(file.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${sha256}"`,
      // Opened on its own, a file can show itself but never run anything. Chrome's PDF viewer
      // won't open in a sandbox, and a PDF can't run the page's scripts anyway.
      'Content-Security-Policy': `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'${type === 'application/pdf' ? '' : '; sandbox'}`,
    });
  };

  // The body is the file itself, streamed to disk; its name comes in the query string.
  app.post('/api/tasks/:id/files', async (c) => {
    const task = getTask(db, me(c), c.req.param('id'));
    if (Number(c.req.header('content-length')) > config.maxFileBytes) return c.json({ error: tooBig() }, 413);
    const name = cleanName(c.req.query('name'));
    const mime = fileType(c.req.header('content-type'), name);
    try {
      const saved = await files.save(c.req.raw.body, config.maxFileBytes);
      return c.json({ file: addAttachment(db, actor(c), task.id, { name, mime, ...saved }) }, 201);
    } catch (err) {
      if (err instanceof FileTooBig) return c.json({ error: tooBig() }, 413);
      throw err;
    }
  });

  app.post('/api/files/:id/preview', async (c) => {
    const file = visibleFile(c);
    if (!file) return gone(c);
    if (!PREVIEW_TYPES.includes((c.req.header('content-type') ?? '').split(';')[0]!.trim())) {
      throw new DomainError('A preview has to be a WebP, JPEG or PNG image.');
    }
    const saved = await files.save(c.req.raw.body, PREVIEW_MAX_BYTES);
    setPreview(db, file.id, saved.sha256);
    return c.body(null, 204);
  });

  app.get('/api/files/:id', async (c) => {
    const file = visibleFile(c);
    if (!file || file.removedAt) return gone(c);
    const { type, inline } = servedAs(file.mime);
    return sendFile(c, file.sha256, type, inline && c.req.query('download') !== '1', file.name);
  });

  app.get('/api/files/:id/preview', async (c) => {
    const file = visibleFile(c);
    if (!file || file.removedAt || !file.previewSha256) return gone(c);
    return sendFile(c, file.previewSha256, imageType, true, file.name);
  });

  app.delete('/api/files/:id', (c) => {
    const file = visibleFile(c);
    if (!file) return gone(c);
    removeAttachment(db, actor(c), file);
    return c.body(null, 204);
  });

  app.post('/api/files/:id/restore', (c) => {
    const file = visibleFile(c);
    if (!file) return gone(c);
    removeAttachment(db, actor(c), file, true);
    return c.body(null, 204);
  });

  // ---- lists --------------------------------------------------------------------------------

  app.get('/api/lists/:groupId', (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    return c.json({ group, ...getListItems(db, group, true), trip: openTrip(db, group) });
  });

  app.put('/api/lists/:groupId/sections', async (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    const input = await body(
      c,
      z.object({
        sections: z.array(z.string().trim().min(1).max(60)).max(40),
        renames: z.array(z.object({ from: z.string().max(60), to: z.string().trim().min(1).max(60) })).max(40).optional(),
      }),
    );
    return c.json({ group: setListSections(db, actor(c), group, input.sections, input.renames) });
  });

  app.post('/api/lists/:groupId/items', async (c) => {
    const group = resolveGroup(db, me(c), c.req.param('groupId'), 'list');
    const input = await body(c, z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(200), ...listItemFields }));
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

  // ---- calendars ----------------------------------------------------------------------------

  // This phone's calendars, or where there are none, how many busy days the person's phone shared.
  app.get('/api/calendars', (c) => c.json({ ...listPhoneCalendars(db, me(c)), sharedDays: sharedBusyDays(db, me(c)) }));

  // The phone's calendar list, when the app opens: answers which count and the window to read them for.
  app.put('/api/calendars/phone', async (c) => {
    const { calendars } = await body(c, z.object({ calendars: z.array(phoneCalendar).max(500) }));
    return c.json(savePhoneCalendars(db, me(c), calendars));
  });

  // Then the events of the ones that count, for that whole window.
  app.put('/api/calendars/phone/events', async (c) => {
    const { events } = await body(c, z.object({ events: z.array(phoneEvent).max(20_000) }));
    return c.json({ saved: savePhoneEvents(db, me(c), events) });
  });

  app.delete('/api/calendars/phone', (c) => {
    stopPhoneCalendars(db, me(c));
    return c.body(null, 204);
  });

  app.patch('/api/calendars/:id', async (c) => {
    const { counts } = await body(c, z.object({ counts: z.boolean() }));
    setCalendarCounts(db, me(c), c.req.param('id'), counts);
    return c.json(listPhoneCalendars(db, me(c)));
  });

  app.get('/api/events', (c) => {
    const viewer = me(c);
    const start = date.safeParse(c.req.query('start')).data ?? planningDate(viewer);
    const end = date.safeParse(c.req.query('end')).data ?? start;
    if (end < start || addDays(start, 62) < end) throw new DomainError('Ask for 62 days or fewer at a time.');
    return c.json({ events: listEvents(db, viewer, start, end) });
  });

  // ---- planning -----------------------------------------------------------------------------

  app.get('/api/briefing', (c) => c.json(getBriefing(db, me(c))));

  app.post('/api/briefing/seen', (c) => {
    markBriefingSeen(db, me(c));
    return c.body(null, 204);
  });

  app.post('/api/briefing/later', async (c) => {
    const { taskId } = await body(c, z.object({ taskId: z.string() }));
    dismissSuggestion(db, me(c), taskId);
    return c.body(null, 204);
  });

  // A day for each unplanned task with a deadline coming up.
  app.get('/api/gaps', (c) => c.json({ gaps: findGaps(db, me(c)) }));

  // The day with the most room for one task before it's due.
  app.get('/api/tasks/:id/gap', (c) => {
    const viewer = me(c);
    const task = getTask(db, viewer, c.req.param('id'));
    if (task.status !== 'open' || !task.dueDate || task.dueDate < planningDate(viewer)) return c.json({ gap: null });
    const person = task.assigneeId ? (resolveMember(db, viewer, task.assigneeId) ?? viewer) : viewer;
    return c.json({ gap: findGap(db, viewer, person, task.dueDate, task.estimateMinutes) });
  });

  app.post('/api/plan-week', async (c) => {
    const { note } = await body(c, z.object({ note: z.string().max(1000).optional() }));
    return c.json(await planMyWeek(db, ai, me(c), { note, timezone: config.timezone }));
  });

  // Tidy-up suggestions for the backlog, or { unavailable } when the model can't help right now.
  app.post('/api/organize', async (c) => {
    try {
      return c.json({ suggestions: await organizeBacklog(db, ai, me(c), config.timezone) });
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      console.warn('Organize backlog unavailable:', err.message);
      const setup = ai.setup();
      return c.json({
        unavailable: setup
          ? `${modelName(setup)} couldn't look at the backlog just now. Try again in a bit.`
          : 'Tidying up needs an AI model. An admin can set one up in Settings, AI.',
      });
    }
  });

  app.post('/api/organize/apply', async (c) => {
    const input = await body(
      c,
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('regroup'), taskId: z.string(), title: z.string(), groupId: z.string(), groupName: z.string(), reason: z.string() }),
        z.object({ kind: z.literal('merge'), taskIds: z.array(z.string()).min(2).max(10), titles: z.array(z.string()), title: z.string().trim().min(1).max(500), reason: z.string() }),
        z.object({ kind: z.literal('split'), taskId: z.string(), title: z.string(), into: z.array(z.string().trim().min(1).max(500)).min(2).max(6), reason: z.string() }),
      ]),
    );
    return c.json(applyOrganize(db, actor(c), input as OrganizeSuggestion));
  });

  // ---- smart add ----------------------------------------------------------------------------

  app.get('/api/ai', (c) => c.json(aiView(ai, db, config, me(c))));

  // An admin picks the model. It's tried first, unless they say to save it anyway.
  app.put('/api/ai', async (c) => {
    if (me(c).role !== 'admin') return c.json({ error: 'Only an admin can change the AI model.' }, 403);
    return c.json(await saveAiSettings(ai, await body(c, aiSettingsInput)));
  });

  // Back to whatever the server's environment sets, which may be nothing.
  app.delete('/api/ai', (c) => {
    if (me(c).role !== 'admin') return c.json({ error: 'Only an admin can change the AI model.' }, 403);
    ai.save(null);
    return c.body(null, 204);
  });

  // Proposals to review, or { fallback } when the model can't help and the app should add it as typed.
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

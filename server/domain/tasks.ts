import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/index.ts';
import { webLink } from '../../shared/links.ts';
import { repeatOn } from '../../shared/repeat.ts';
import { activity, groups, members, series, subtasks, taskLinks, tasks, type Member, type Task } from '../db/schema.ts';
import { addDays, dateOf, daysBetween, planningDate, planningDayStart } from '../lib/dates.ts';
import { attachmentsFor, copyAttachments, type FileView } from './files.ts';
import { DomainError, logActivity, type Actor } from './household.ts';
import { carryReminders, remindersFor, setReminder, shiftReminders, type ReminderView } from './reminders.ts';
import { anchorRule, cleanRepeat, firstOccurrence, nextDate, type Repeat } from './repeat.ts';

export type TimeOfDay = NonNullable<Task['timeOfDay']>;

export interface TaskDetail extends Task {
  groupName: string | null;
  /** The list this task is a trip for, like Groceries for a grocery run. */
  listName: string | null;
  assigneeName: string | null;
  createdByName: string | null;
  subtasks: { id: string; title: string; done: boolean }[];
  links: { id: string; url: string; title: string | null }[];
  /** How it repeats, if it does. */
  repeat: Repeat | null;
  pausedUntil: string | null;
  /** The viewer's own reminder about it; other people's stay theirs. */
  reminder: ReminderView | null;
  files: FileView[];
}

export interface TaskFilter {
  status?: 'open' | 'done' | 'all';
  plannedOn?: string;
  plannedBefore?: string;
  plannedFrom?: string;
  plannedTo?: string;
  unplanned?: boolean;
  dueOnOrBefore?: string;
  groupId?: string;
  /** Tasks for this member; `includeShared` adds unassigned ones. */
  assignee?: { memberId: string; includeShared: boolean } | 'unassigned';
  /** Every word must appear in the title or notes. */
  query?: string;
  completedSince?: Date;
  limit?: number;
  order?: 'backlog' | 'recent';
}

const creators = alias(members, 'creators');
const lists = alias(groups, 'lists');
const columns = {
  task: tasks,
  groupName: groups.name,
  listName: lists.name,
  listPrivateTo: lists.privateTo,
  assigneeName: members.name,
  createdByName: creators.name,
  repeat: series.rule,
  pausedUntil: series.pausedUntil,
};
type Row = {
  task: Task;
  groupName: string | null;
  listName: string | null;
  listPrivateTo: string | null;
  assigneeName: string | null;
  createdByName: string | null;
  repeat: Repeat | null;
  pausedUntil: string | null;
};

function selectTasks(db: Db) {
  return db
    .select(columns)
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .leftJoin(members, eq(tasks.assigneeId, members.id))
    .leftJoin(creators, eq(tasks.createdById, creators.id))
    .leftJoin(lists, eq(tasks.listId, lists.id))
    .leftJoin(series, eq(tasks.seriesId, series.id));
}

/** Tasks in another member's private group are invisible; everything else is shared. */
function visibleTo(memberId: string) {
  return or(isNull(tasks.groupId), isNull(groups.privateTo), eq(groups.privateTo, memberId));
}

function likeWord(word: string) {
  const pattern = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(
    sql`${tasks.title} LIKE ${pattern} ESCAPE '\\'`,
    sql`coalesce(${tasks.notes}, '') LIKE ${pattern} ESCAPE '\\'`,
  )!;
}

function conditions(me: Member, f: TaskFilter): SQL[] {
  const where: SQL[] = [visibleTo(me.id)!];
  const status = f.status ?? 'open';
  if (status !== 'all') where.push(eq(tasks.status, status));
  else where.push(sql`${tasks.status} != 'archived'`);
  if (f.plannedOn) where.push(eq(tasks.plannedDate, f.plannedOn));
  if (f.plannedBefore) where.push(lt(tasks.plannedDate, f.plannedBefore));
  if (f.plannedFrom) where.push(gte(tasks.plannedDate, f.plannedFrom));
  if (f.plannedTo) where.push(lte(tasks.plannedDate, f.plannedTo));
  if (f.unplanned) where.push(isNull(tasks.plannedDate));
  if (f.dueOnOrBefore) where.push(and(isNotNull(tasks.dueDate), lte(tasks.dueDate, f.dueOnOrBefore))!);
  if (f.groupId) where.push(eq(tasks.groupId, f.groupId));
  if (f.assignee === 'unassigned') where.push(isNull(tasks.assigneeId));
  else if (f.assignee) {
    where.push(
      f.assignee.includeShared
        ? or(eq(tasks.assigneeId, f.assignee.memberId), isNull(tasks.assigneeId))!
        : eq(tasks.assigneeId, f.assignee.memberId),
    );
  }
  for (const word of (f.query ?? '').split(/\s+/).filter(Boolean)) where.push(likeWord(word));
  if (f.completedSince) where.push(gte(tasks.completedAt, f.completedSince));
  return where;
}

export function listTasks(db: Db, me: Member, filter: TaskFilter = {}): TaskDetail[] {
  const order =
    filter.order === 'recent'
      ? [desc(sql`coalesce(${tasks.completedAt}, ${tasks.updatedAt})`)]
      : [
          desc(tasks.mustDo),
          sql`${tasks.dueDate} IS NULL`,
          asc(tasks.dueDate),
          asc(tasks.sortOrder),
          asc(tasks.createdAt),
        ];
  const rows = selectTasks(db)
    .where(and(...conditions(me, filter)))
    .orderBy(...order)
    .limit(filter.limit ?? 500)
    .all();
  return withDetails(db, rows, me.id);
}

function withDetails(db: Db, rows: Row[], viewerId: string): TaskDetail[] {
  const ids = rows.map((r) => r.task.id);
  if (ids.length === 0) return [];
  const subs = db.select().from(subtasks).where(inArray(subtasks.taskId, ids)).orderBy(asc(subtasks.sortOrder)).all();
  const links = db.select().from(taskLinks).where(inArray(taskLinks.taskId, ids)).orderBy(asc(taskLinks.createdAt)).all();
  const reminders = remindersFor(db, viewerId, ids);
  const files = attachmentsFor(db, ids);
  return rows.map(({ task, groupName, listName, listPrivateTo, assigneeName, createdByName, repeat, pausedUntil }) => ({
    ...task,
    groupName,
    // Someone else's private list stays theirs, even on a task they can see.
    listName: listPrivateTo && listPrivateTo !== viewerId ? null : listName,
    assigneeName,
    createdByName,
    repeat: task.seriesId ? repeat : null,
    pausedUntil: task.seriesId ? pausedUntil : null,
    subtasks: subs.filter((s) => s.taskId === task.id).map(({ id, title, done }) => ({ id, title, done })),
    links: links.filter((l) => l.taskId === task.id).map(({ id, url, title }) => ({ id, url, title })),
    reminder: reminders.get(task.id) ?? null,
    files: files.get(task.id) ?? [],
  }));
}

/** Finds one visible task by full id or a unique id prefix (at least 6 characters). */
export function getTask(db: Db, me: Member, ref: string): TaskDetail {
  if (ref.length < 6 || !/^[0-9a-f-]+$/i.test(ref)) throw new DomainError(`"${ref}" isn't a task id.`);
  const idMatch = ref.length >= 36 ? eq(tasks.id, ref) : sql`${tasks.id} LIKE ${`${ref.toLowerCase()}%`}`;
  const rows = selectTasks(db)
    .where(and(idMatch, visibleTo(me.id)))
    .limit(2)
    .all();
  if (rows.length === 0) throw new DomainError(`No task with id ${ref}.`);
  if (rows.length > 1) throw new DomainError(`More than one task starts with ${ref}. Use more of the id.`);
  return withDetails(db, rows, me.id)[0]!;
}

/**
 * A day list as `me` sees it (their planning date): one person's tasks plus shared ones, or
 * everyone's.
 */
export function getToday(db: Db, me: Member, who: Member | 'everyone' = me) {
  const today = planningDate(me);
  const assignee = who === 'everyone' ? undefined : { memberId: who.id, includeShared: true };
  const planned = listTasks(db, me, { plannedOn: today, assignee });
  const carriedOver = listTasks(db, me, { plannedBefore: today, assignee });
  const due = listTasks(db, me, { dueOnOrBefore: today, assignee }).filter(
    (t) => !t.plannedDate || t.plannedDate > today,
  );
  const done = listTasks(db, me, {
    status: 'done',
    completedSince: planningDayStart(me, today),
    assignee,
    order: 'recent',
  });
  return { today, planned, carriedOver, due, done };
}

/** A step to add: its title, or an id the app chose so it can change the step before it syncs. */
export type NewSubtask = string | { id: string; title: string };

export interface NewLink {
  id?: string;
  url: string;
  title?: string | null;
}

export interface NewTask {
  /** Chosen by the app, so a task made offline keeps one id once it syncs. */
  id?: string;
  title: string;
  notes?: string | null;
  groupId?: string | null;
  /** Defaults to the actor. Null means shared, for whoever gets to it. */
  assigneeId?: string | null;
  dueDate?: string | null;
  plannedDate?: string | null;
  timeOfDay?: TimeOfDay | null;
  mustDo?: boolean;
  estimateMinutes?: number | null;
  /** Who sized it: the person (the default) or the model. */
  estimateSource?: 'user' | 'ai';
  subtasks?: NewSubtask[];
  links?: NewLink[];
  repeat?: Repeat | null;
  /** A reminder for the person adding it. */
  remindAt?: Date | null;
  /** The list it's a trip for. */
  listId?: string | null;
}

// ---- changes sent late --------------------------------------------------------------------

/** The planning day a change belongs to: today, or the day it was made when the app sends it late. */
function actorToday(actor: Actor) {
  return actor.at ? dateOf(actor.member, actor.at) : planningDate(actor.member);
}

/** Fields compared one by one when a change arrives late. Steps and links are sets, so they merge. */
const SCALAR_FIELDS = new Set(['title', 'notes', 'groupId', 'dueDate', 'plannedDate', 'timeOfDay', 'mustDo', 'estimateMinutes', 'repeat', 'pausedUntil']);

/**
 * What someone changed on a task after a late change was made (the app was offline). The later
 * change wins, so the late one leaves these fields alone.
 */
function changedSince(db: Db, actor: Actor, taskId: string): Set<string> {
  const out = new Set<string>();
  if (!actor.at) return out;
  const rows = db
    .select({ action: activity.action, detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.taskId, taskId), gt(activity.createdAt, actor.at)))
    .all();
  for (const { action, detail } of rows) {
    if (action === 'task.updated') for (const f of (detail as { fields?: string[] } | null)?.fields ?? []) out.add(f);
    else if (action === 'task.moved') out.add('plannedDate');
    else if (action === 'task.skipped') out.add('plannedDate').add('dueDate');
    else if (action === 'task.assigned') out.add('assigneeId');
    else if (['task.completed', 'task.reopened', 'task.archived', 'task.restored'].includes(action)) out.add('status');
  }
  return out;
}

/** The date field a rule's tasks use, as a patch. */
function onDate(rule: Repeat, date: string | null): Pick<Task, 'plannedDate'> | Pick<Task, 'dueDate'> {
  return repeatOn(rule) === 'due' ? { dueDate: date } : { plannedDate: date };
}

function seriesDate(task: Pick<Task, 'plannedDate' | 'dueDate'>, rule: Repeat) {
  return repeatOn(rule) === 'due' ? task.dueDate : task.plannedDate;
}

/**
 * Starts a series for a task. A scheduled one with no date yet gets its first date from the rule;
 * "every Sunday" added on a Wednesday lands on Sunday.
 */
function startSeries(db: Db, actor: Actor, input: Repeat, task: Pick<Task, 'plannedDate' | 'dueDate'>) {
  const rule = cleanRepeat(input);
  const today = actorToday(actor);
  const given = seriesDate(task, rule);
  const first = given ?? (rule.mode === 'schedule' ? firstOccurrence(rule, today, today) : null);
  const anchor = first ?? today;
  const row = db.insert(series).values({ rule: anchorRule(rule, anchor), anchor }).returning().get();
  return { seriesId: row.id, dates: given || !first ? {} : onDate(rule, first) };
}

export function createTasks(db: Db, actor: Actor, inputs: NewTask[]): TaskDetail[] {
  const ids = db.transaction(() =>
    inputs.map((input) => {
      const now = new Date();
      const title = input.title.trim();
      if (!title) throw new DomainError('A task needs a title.');
      // Sent twice (the first answer was lost): the first one stands.
      if (input.id && db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, input.id)).get()) return input.id;
      const task = db
        .insert(tasks)
        .values({
          ...(input.id && { id: input.id }),
          title,
          notes: input.notes?.trim() || null,
          groupId: input.groupId ?? null,
          listId: input.listId ?? null,
          assigneeId: input.assigneeId === undefined ? actor.member.id : input.assigneeId,
          createdById: actor.member.id,
          dueDate: input.dueDate ?? null,
          plannedDate: input.plannedDate ?? null,
          timeOfDay: input.timeOfDay ?? null,
          mustDo: input.mustDo ?? false,
          estimateMinutes: input.estimateMinutes ?? null,
          estimateSource: input.estimateMinutes != null ? (input.estimateSource ?? 'user') : null,
          aiEstimateMinutes: input.estimateSource === 'ai' ? (input.estimateMinutes ?? null) : null,
          createdAt: actor.at ?? now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (input.repeat) {
        const { seriesId, dates } = startSeries(db, actor, input.repeat, task);
        db.update(tasks).set({ seriesId, ...dates }).where(eq(tasks.id, task.id)).run();
      }
      addSubtasks(db, task.id, input.subtasks ?? []);
      addLinks(db, task.id, input.links ?? []);
      if (input.remindAt) setReminder(db, actor.member, task.id, input.remindAt, actor.at != null);
      logActivity(db, actor, 'task.created', task.id, { title });
      return task.id;
    }),
  );
  return ids.map((id) => getTask(db, actor.member, id));
}

function addSubtasks(db: Db, taskId: string, items: NewSubtask[]) {
  const clean = items
    .map((s) => (typeof s === 'string' ? { id: undefined, title: s.trim() } : { id: s.id, title: s.title.trim() }))
    .filter((s) => s.title);
  if (clean.length === 0) return;
  const [last] = db
    .select({ max: sql<number>`coalesce(max(${subtasks.sortOrder}), -1)` })
    .from(subtasks)
    .where(eq(subtasks.taskId, taskId))
    .all();
  const start = (last?.max ?? -1) + 1;
  db.insert(subtasks)
    .values(clean.map(({ id, title }, i) => ({ ...(id && { id }), taskId, title, sortOrder: start + i })))
    .onConflictDoNothing()
    .run();
}

function addLinks(db: Db, taskId: string, links: NewLink[]) {
  for (const link of links) {
    const url = webLink(link.url);
    if (!url) throw new DomainError(`"${link.url}" isn't a web link.`);
    db.insert(taskLinks)
      .values({ ...(link.id && { id: link.id }), taskId, url, title: link.title?.trim() || null })
      .onConflictDoNothing()
      .run();
  }
}

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  groupId?: string | null;
  dueDate?: string | null;
  plannedDate?: string | null;
  timeOfDay?: TimeOfDay | null;
  mustDo?: boolean;
  estimateMinutes?: number | null;
  addSubtasks?: NewSubtask[];
  checkSubtasks?: string[];
  uncheckSubtasks?: string[];
  removeSubtasks?: string[];
  addLinks?: NewLink[];
  removeLinks?: string[];
  /** A new rule, or null to stop repeating. */
  repeat?: Repeat | null;
  /** Don't bring it back before this date; null ends a pause. */
  pausedUntil?: string | null;
  /** The actor's own reminder: a time, or null to clear it. */
  remindAt?: Date | null;
}

/** Step ids from refs. A late change skips steps that are gone rather than failing. */
function subtaskIds(task: TaskDetail, refs: string[], lenient = false) {
  return refs.flatMap((ref) => {
    const q = ref.trim().toLowerCase();
    const hit =
      task.subtasks.find((s) => s.id === ref || (q.length >= 6 && s.id.startsWith(q))) ??
      task.subtasks.find((s) => s.title.toLowerCase() === q);
    if (!hit && lenient) return [];
    if (!hit) throw new DomainError(`"${task.title}" has no subtask "${ref}".`);
    return [hit.id];
  });
}

export function updateTask(db: Db, actor: Actor, ref: string, input: TaskPatch): TaskDetail {
  const task = getTask(db, actor.member, ref);
  const later = changedSince(db, actor, task.id);
  const patch = Object.fromEntries(Object.entries(input).filter(([k]) => !(SCALAR_FIELDS.has(k) && later.has(k)))) as TaskPatch;
  const lenient = actor.at != null;
  db.transaction(() => {
    const fields: Partial<Task> = {};
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new DomainError('A task needs a title.');
      fields.title = patch.title.trim();
    }
    if (patch.notes !== undefined) fields.notes = patch.notes?.trim() || null;
    if (patch.groupId !== undefined) fields.groupId = patch.groupId;
    if (patch.dueDate !== undefined) fields.dueDate = patch.dueDate;
    if (patch.plannedDate !== undefined) fields.plannedDate = patch.plannedDate;
    if (patch.timeOfDay !== undefined) fields.timeOfDay = patch.timeOfDay;
    if (patch.mustDo !== undefined) fields.mustDo = patch.mustDo;
    if (patch.estimateMinutes !== undefined) {
      fields.estimateMinutes = patch.estimateMinutes;
      fields.estimateSource = patch.estimateMinutes == null ? null : 'user';
    }
    db.update(tasks)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .run();
    addSubtasks(db, task.id, patch.addSubtasks ?? []);
    const check = (refs: string[] | undefined, done: boolean) => {
      if (!refs?.length) return;
      db.update(subtasks)
        .set({ done })
        .where(and(eq(subtasks.taskId, task.id), inArray(subtasks.id, subtaskIds(task, refs, lenient))))
        .run();
    };
    check(patch.checkSubtasks, true);
    check(patch.uncheckSubtasks, false);
    if (patch.removeSubtasks?.length) {
      db.delete(subtasks)
        .where(and(eq(subtasks.taskId, task.id), inArray(subtasks.id, subtaskIds(task, patch.removeSubtasks, lenient))))
        .run();
    }
    addLinks(db, task.id, patch.addLinks ?? []);
    if (patch.removeLinks?.length) {
      const ids = patch.removeLinks.flatMap((ref) => {
        const url = URL.canParse(ref) ? new URL(ref).toString() : ref;
        const hit = task.links.find((l) => l.id === ref || l.url === url || (ref.length >= 6 && l.id.startsWith(ref)));
        if (!hit && lenient) return [];
        if (!hit) throw new DomainError(`"${task.title}" has no link "${ref}".`);
        return [hit.id];
      });
      db.delete(taskLinks).where(inArray(taskLinks.id, ids)).run();
    }
    if (patch.repeat !== undefined) setRepeat(db, actor, task.id, patch.repeat);
    if (patch.pausedUntil !== undefined) pauseSeries(db, task.id, patch.pausedUntil);
    if (patch.remindAt !== undefined) setReminder(db, actor.member, task.id, patch.remindAt, lenient);
    // A reminder is the person's own, so it stays out of the household's activity.
    const changed = Object.entries(patch)
      .filter(([k, v]) => v !== undefined && k !== 'remindAt')
      .map(([k]) => k);
    if (changed.length) logActivity(db, actor, 'task.updated', task.id, { fields: changed });
  });
  return getTask(db, actor.member, task.id);
}

// ---- repeating ------------------------------------------------------------------------------

function seriesOf(db: Db, task: Pick<Task, 'seriesId'>) {
  return task.seriesId ? (db.select().from(series).where(eq(series.id, task.seriesId)).get() ?? null) : null;
}

/** Moves a task's date to `date`, shifting its other date (say a deadline) by the same amount. */
function shiftDates(task: Pick<Task, 'plannedDate' | 'dueDate'>, rule: Repeat, date: string) {
  const current = seriesDate(task, rule);
  const other = repeatOn(rule) === 'due' ? task.plannedDate : task.dueDate;
  const shifted = other && current ? addDays(other, daysBetween(current, date)) : null;
  return repeatOn(rule) === 'due' ? { dueDate: date, plannedDate: shifted } : { plannedDate: date, dueDate: shifted };
}

function setRepeat(db: Db, actor: Actor, taskId: string, input: Repeat | null) {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  if (input === null) {
    // Earlier ones keep their series for history; this one just stops coming back.
    db.update(tasks).set({ seriesId: null }).where(eq(tasks.id, taskId)).run();
    return;
  }
  const existing = seriesOf(db, task);
  if (!existing) {
    const { seriesId, dates } = startSeries(db, actor, input, task);
    db.update(tasks).set({ seriesId, ...dates }).where(eq(tasks.id, taskId)).run();
    return;
  }
  const rule = cleanRepeat(input);
  const current = seriesDate(task, rule);
  const anchor = current ?? existing.anchor;
  db.update(series).set({ rule: anchorRule(rule, anchor), anchor }).where(eq(series.id, existing.id)).run();
  if (!current && rule.mode === 'schedule') {
    const first = firstOccurrence(rule, anchor, actorToday(actor), existing.pausedUntil);
    if (first) db.update(tasks).set(onDate(rule, first)).where(eq(tasks.id, taskId)).run();
  }
}

function pauseSeries(db: Db, taskId: string, until: string | null) {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  const s = seriesOf(db, task);
  if (!s) throw new DomainError(`"${task.title}" doesn't repeat, so there's nothing to pause.`);
  db.update(series).set({ pausedUntil: until }).where(eq(series.id, s.id)).run();
  const current = seriesDate(task, s.rule);
  if (until && (!current || current < until)) {
    // The open one waits too: it moves to the first date on or after the pause ends.
    const date = s.rule.mode === 'after' ? until : firstOccurrence(s.rule, s.anchor, until);
    if (date) db.update(tasks).set(shiftDates(task, s.rule, date)).where(eq(tasks.id, taskId)).run();
  }
}

/** After finishing a repeating task, makes the next one, unless the series already has one open. */
function spawnNext(db: Db, actor: Actor, task: TaskDetail) {
  const s = seriesOf(db, task);
  if (!s) return null;
  const open = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.seriesId, s.id), eq(tasks.status, 'open'), ne(tasks.id, task.id)))
    .get();
  if (open) return null;
  const date = nextDate(s.rule, s.anchor, seriesDate(task, s.rule), actorToday(actor), s.pausedUntil);
  if (!date) return null;
  const now = new Date();
  const next = db
    .insert(tasks)
    .values({
      title: task.title,
      notes: task.notes,
      groupId: task.groupId,
      // A weekly grocery run stays a trip for the same list.
      listId: task.listId,
      assigneeId: task.assigneeId,
      createdById: task.createdById,
      timeOfDay: task.timeOfDay,
      mustDo: task.mustDo,
      estimateMinutes: task.estimateMinutes,
      estimateSource: task.estimateSource,
      seriesId: s.id,
      ...shiftDates(task, s.rule, date),
      // Equal stamps mark it untouched, so undoing the completion can take it back.
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  addSubtasks(
    db,
    next.id,
    task.subtasks.map((st) => st.title),
  );
  for (const link of task.links) db.insert(taskLinks).values({ taskId: next.id, url: link.url, title: link.title }).run();
  const current = seriesDate(task, s.rule);
  carryReminders(db, task.id, next.id, current ? daysBetween(current, date) : 0);
  copyAttachments(db, task.id, next.id);
  return { id: next.id, date };
}

/** Undoing a completion takes back the next one it made, if nobody has changed it since. */
function takeBackNext(db: Db, task: TaskDetail) {
  const last = db
    .select({ detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.taskId, task.id), eq(activity.action, 'task.completed')))
    .orderBy(desc(activity.createdAt), desc(sql`activity.rowid`))
    .limit(1)
    .get();
  const nextId = (last?.detail as { next?: { id?: string } } | null)?.next?.id;
  if (!nextId) return;
  const next = db.select().from(tasks).where(eq(tasks.id, nextId)).get();
  if (next && next.status === 'open' && next.createdAt.getTime() === next.updatedAt.getTime()) {
    db.delete(tasks).where(eq(tasks.id, next.id)).run();
  }
}

/** Skips the next time a repeating task comes up, moving it to the date after. */
export function skipTask(db: Db, actor: Actor, ref: string): TaskDetail {
  const task = getTask(db, actor.member, ref);
  const s = seriesOf(db, task);
  if (!s || task.status !== 'open') throw new DomainError(`"${task.title}" isn't an open repeating task, so there's nothing to skip.`);
  const today = planningDate(actor.member);
  const current = seriesDate(task, s.rule);
  const date =
    s.rule.mode === 'after'
      ? nextDate(s.rule, s.anchor, null, current && current > today ? current : today, s.pausedUntil)
      : nextDate(s.rule, s.anchor, current, today, s.pausedUntil);
  if (!date) throw new DomainError(`"${task.title}" has no later date to skip to.`);
  db.transaction(() => {
    db.update(tasks)
      .set({ ...shiftDates(task, s.rule, date), updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .run();
    if (current) shiftReminders(db, task.id, daysBetween(current, date));
    logActivity(db, actor, 'task.skipped', task.id, { from: current, to: date });
  });
  return getTask(db, actor.member, task.id);
}

/** Marks tasks done, or open again with `done: false`. Finishing a repeating task makes the next one. */
export function completeTasks(db: Db, actor: Actor, refs: string[], done = true): TaskDetail[] {
  const found = refs.map((ref) => getTask(db, actor.member, ref));
  db.transaction(() => {
    for (const task of found) {
      if (changedSince(db, actor, task.id).has('status')) continue;
      if (task.status === 'archived') throw new DomainError(`"${task.title}" was removed. Restore it first.`);
      if ((task.status === 'done') === done) continue;
      const now = new Date();
      db.update(tasks)
        .set(
          done
            ? { status: 'done', completedAt: actor.at ?? now, completedById: actor.member.id, updatedAt: now }
            : { status: 'open', completedAt: null, completedById: null, updatedAt: now },
        )
        .where(eq(tasks.id, task.id))
        .run();
      if (done) {
        const next = spawnNext(db, actor, task);
        logActivity(db, actor, 'task.completed', task.id, next ? { next } : undefined);
      } else {
        takeBackNext(db, task);
        logActivity(db, actor, 'task.reopened', task.id);
      }
    }
  });
  return found.map((t) => getTask(db, actor.member, t.id));
}

/** Puts tasks on a day's list, or back in the backlog with `null`. */
export function moveTasks(db: Db, actor: Actor, refs: string[], plannedDate: string | null): TaskDetail[] {
  const found = refs.map((ref) => getTask(db, actor.member, ref));
  db.transaction(() => {
    for (const task of found) {
      if (changedSince(db, actor, task.id).has('plannedDate')) continue;
      db.update(tasks).set({ plannedDate, updatedAt: new Date() }).where(eq(tasks.id, task.id)).run();
      logActivity(db, actor, 'task.moved', task.id, { from: task.plannedDate, to: plannedDate });
    }
  });
  return found.map((t) => getTask(db, actor.member, t.id));
}

/** Hands a task to someone (or to no one in particular). A note travels with it, e.g. when handing it back. */
export function assignTask(db: Db, actor: Actor, ref: string, assigneeId: string | null, note?: string | null) {
  const task = getTask(db, actor.member, ref);
  if (changedSince(db, actor, task.id).has('assigneeId')) return task;
  db.transaction(() => {
    db.update(tasks)
      .set({ assigneeId, handedBackNote: note?.trim() || null, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .run();
    logActivity(db, actor, 'task.assigned', task.id, { from: task.assigneeId, to: assigneeId, note: note ?? null });
  });
  return getTask(db, actor.member, task.id);
}

/** Removes tasks from every view. They stay in the database and can be restored. */
export function archiveTasks(db: Db, actor: Actor, refs: string[], restore = false): TaskDetail[] {
  const found = refs.map((ref) => getTask(db, actor.member, ref));
  db.transaction(() => {
    for (const task of found) {
      if (changedSince(db, actor, task.id).has('status')) continue;
      const status = restore ? (task.completedAt ? 'done' : 'open') : 'archived';
      db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, task.id)).run();
      logActivity(db, actor, restore ? 'task.restored' : 'task.archived', task.id);
    }
  });
  return found.map((t) => getTask(db, actor.member, t.id));
}

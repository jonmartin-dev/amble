import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { groups, members, subtasks, taskLinks, tasks, type Member, type Task } from '../db/schema.ts';
import { planningDate, planningDayStart } from '../lib/dates.ts';
import { DomainError, logActivity, type Actor } from './household.ts';

export type TimeOfDay = NonNullable<Task['timeOfDay']>;

export interface TaskDetail extends Task {
  groupName: string | null;
  assigneeName: string | null;
  subtasks: { id: string; title: string; done: boolean }[];
  links: { id: string; url: string; title: string | null }[];
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
  const rows = db
    .select({ task: tasks, groupName: groups.name, assigneeName: members.name })
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .leftJoin(members, eq(tasks.assigneeId, members.id))
    .where(and(...conditions(me, filter)))
    .orderBy(...order)
    .limit(filter.limit ?? 500)
    .all();
  return withDetails(db, rows);
}

function withDetails(
  db: Db,
  rows: { task: Task; groupName: string | null; assigneeName: string | null }[],
): TaskDetail[] {
  const ids = rows.map((r) => r.task.id);
  if (ids.length === 0) return [];
  const subs = db.select().from(subtasks).where(inArray(subtasks.taskId, ids)).orderBy(asc(subtasks.sortOrder)).all();
  const links = db.select().from(taskLinks).where(inArray(taskLinks.taskId, ids)).orderBy(asc(taskLinks.createdAt)).all();
  return rows.map(({ task, groupName, assigneeName }) => ({
    ...task,
    groupName,
    assigneeName,
    subtasks: subs.filter((s) => s.taskId === task.id).map(({ id, title, done }) => ({ id, title, done })),
    links: links.filter((l) => l.taskId === task.id).map(({ id, url, title }) => ({ id, url, title })),
  }));
}

/** Finds one visible task by full id or a unique id prefix (at least 6 characters). */
export function getTask(db: Db, me: Member, ref: string): TaskDetail {
  if (ref.length < 6 || !/^[0-9a-f-]+$/i.test(ref)) throw new DomainError(`"${ref}" isn't a task id.`);
  const idMatch = ref.length >= 36 ? eq(tasks.id, ref) : sql`${tasks.id} LIKE ${`${ref.toLowerCase()}%`}`;
  const rows = db
    .select({ task: tasks, groupName: groups.name, assigneeName: members.name })
    .from(tasks)
    .leftJoin(groups, eq(tasks.groupId, groups.id))
    .leftJoin(members, eq(tasks.assigneeId, members.id))
    .where(and(idMatch, visibleTo(me.id)))
    .limit(2)
    .all();
  if (rows.length === 0) throw new DomainError(`No task with id ${ref}.`);
  if (rows.length > 1) throw new DomainError(`More than one task starts with ${ref}. Use more of the id.`);
  return withDetails(db, rows)[0]!;
}

export function getToday(db: Db, me: Member, scope: 'mine' | 'everyone' = 'mine') {
  const today = planningDate(me);
  const assignee = scope === 'mine' ? { memberId: me.id, includeShared: true } : undefined;
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

export interface NewTask {
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
  subtasks?: string[];
  links?: { url: string; title?: string | null }[];
}

export function createTasks(db: Db, actor: Actor, inputs: NewTask[]): TaskDetail[] {
  const ids = db.transaction(() =>
    inputs.map((input) => {
      const now = new Date();
      const title = input.title.trim();
      if (!title) throw new DomainError('A task needs a title.');
      const task = db
        .insert(tasks)
        .values({
          title,
          notes: input.notes?.trim() || null,
          groupId: input.groupId ?? null,
          assigneeId: input.assigneeId === undefined ? actor.member.id : input.assigneeId,
          createdById: actor.member.id,
          dueDate: input.dueDate ?? null,
          plannedDate: input.plannedDate ?? null,
          timeOfDay: input.timeOfDay ?? null,
          mustDo: input.mustDo ?? false,
          estimateMinutes: input.estimateMinutes ?? null,
          estimateSource: input.estimateMinutes != null ? 'user' : null,
          updatedAt: now,
        })
        .returning()
        .get();
      addSubtasks(db, task.id, input.subtasks ?? []);
      addLinks(db, task.id, input.links ?? []);
      logActivity(db, actor, 'task.created', task.id, { title });
      return task.id;
    }),
  );
  return ids.map((id) => getTask(db, actor.member, id));
}

function addSubtasks(db: Db, taskId: string, titles: string[]) {
  const clean = titles.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return;
  const [last] = db
    .select({ max: sql<number>`coalesce(max(${subtasks.sortOrder}), -1)` })
    .from(subtasks)
    .where(eq(subtasks.taskId, taskId))
    .all();
  const start = (last?.max ?? -1) + 1;
  db.insert(subtasks)
    .values(clean.map((title, i) => ({ taskId, title, sortOrder: start + i })))
    .run();
}

function addLinks(db: Db, taskId: string, links: { url: string; title?: string | null }[]) {
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      throw new DomainError(`"${link.url}" isn't a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DomainError('Links must be http or https.');
    db.insert(taskLinks)
      .values({ taskId, url: url.toString(), title: link.title?.trim() || null })
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
  addSubtasks?: string[];
  checkSubtasks?: string[];
  uncheckSubtasks?: string[];
  addLinks?: { url: string; title?: string | null }[];
  removeLinks?: string[];
}

function subtaskIds(task: TaskDetail, refs: string[]) {
  return refs.map((ref) => {
    const q = ref.trim().toLowerCase();
    const hit =
      task.subtasks.find((s) => s.id === ref || (q.length >= 6 && s.id.startsWith(q))) ??
      task.subtasks.find((s) => s.title.toLowerCase() === q);
    if (!hit) throw new DomainError(`"${task.title}" has no subtask "${ref}".`);
    return hit.id;
  });
}

export function updateTask(db: Db, actor: Actor, ref: string, patch: TaskPatch): TaskDetail {
  const task = getTask(db, actor.member, ref);
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
        .where(and(eq(subtasks.taskId, task.id), inArray(subtasks.id, subtaskIds(task, refs))))
        .run();
    };
    check(patch.checkSubtasks, true);
    check(patch.uncheckSubtasks, false);
    addLinks(db, task.id, patch.addLinks ?? []);
    if (patch.removeLinks?.length) {
      const ids = patch.removeLinks.map((ref) => {
        const url = URL.canParse(ref) ? new URL(ref).toString() : ref;
        const hit = task.links.find((l) => l.id === ref || l.url === url || (ref.length >= 6 && l.id.startsWith(ref)));
        if (!hit) throw new DomainError(`"${task.title}" has no link "${ref}".`);
        return hit.id;
      });
      db.delete(taskLinks).where(inArray(taskLinks.id, ids)).run();
    }
    logActivity(db, actor, 'task.updated', task.id, { fields: Object.keys(patch) });
  });
  return getTask(db, actor.member, task.id);
}

/** Marks tasks done, or open again with `done: false`. */
export function completeTasks(db: Db, actor: Actor, refs: string[], done = true): TaskDetail[] {
  const found = refs.map((ref) => getTask(db, actor.member, ref));
  db.transaction(() => {
    for (const task of found) {
      if (task.status === 'archived') throw new DomainError(`"${task.title}" was removed. Restore it first.`);
      if ((task.status === 'done') === done) continue;
      const now = new Date();
      db.update(tasks)
        .set(
          done
            ? { status: 'done', completedAt: now, completedById: actor.member.id, updatedAt: now }
            : { status: 'open', completedAt: null, completedById: null, updatedAt: now },
        )
        .where(eq(tasks.id, task.id))
        .run();
      logActivity(db, actor, done ? 'task.completed' : 'task.reopened', task.id);
    }
  });
  return found.map((t) => getTask(db, actor.member, t.id));
}

/** Puts tasks on a day's list, or back in the backlog with `null`. */
export function moveTasks(db: Db, actor: Actor, refs: string[], plannedDate: string | null): TaskDetail[] {
  const found = refs.map((ref) => getTask(db, actor.member, ref));
  db.transaction(() => {
    for (const task of found) {
      db.update(tasks).set({ plannedDate, updatedAt: new Date() }).where(eq(tasks.id, task.id)).run();
      logActivity(db, actor, 'task.moved', task.id, { from: task.plannedDate, to: plannedDate });
    }
  });
  return found.map((t) => getTask(db, actor.member, t.id));
}

/** Hands a task to someone (or to no one in particular). A note travels with it, e.g. when handing it back. */
export function assignTask(db: Db, actor: Actor, ref: string, assigneeId: string | null, note?: string | null) {
  const task = getTask(db, actor.member, ref);
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
      const status = restore ? (task.completedAt ? 'done' : 'open') : 'archived';
      db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, task.id)).run();
      logActivity(db, actor, restore ? 'task.restored' : 'task.archived', task.id);
    }
  });
  return found.map((t) => getTask(db, actor.member, t.id));
}

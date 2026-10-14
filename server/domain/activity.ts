import { and, desc, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/index.ts';
import { activity, groups, members, tasks, type Member } from '../db/schema.ts';
import { DomainError } from './household.ts';

export interface ActivityEntry {
  id: string;
  at: Date;
  memberId: string | null;
  memberName: string | null;
  via: 'app' | 'claude' | 'system';
  action: string;
  taskId: string | null;
  taskTitle: string | null;
  detail: Record<string, unknown> | null;
  /** How many changes this entry stands for. Repeated edits to one task close together fold into one. */
  count: number;
}

// Edits to the same task by the same person within this span read as one change.
const MERGE_WINDOW_MS = 30 * 60_000;

type Entry = ActivityEntry & { oldest: Row };

const taskGroups = alias(groups, 'task_groups');
// Several changes can land in the same millisecond, so insertion order breaks ties.
const seq = sql<number>`activity.rowid`;

type Row = {
  a: typeof activity.$inferSelect;
  seq: number;
  memberName: string | null;
  taskTitle: string | null;
};

function cursorOf(row: Pick<Row, 'a' | 'seq'>) {
  return `${row.a.createdAt.getTime()}_${row.seq}`;
}

function parseCursor(cursor: string): SQL {
  const [ms, n] = cursor.split('_').map(Number);
  if (!Number.isFinite(ms) || !Number.isFinite(n)) throw new DomainError("That page of activity doesn't exist.");
  const at = new Date(ms!);
  return or(lt(activity.createdAt, at), and(eq(activity.createdAt, at), sql`${seq} < ${n}`))!;
}

/** Group and list changes name their group; hide the ones in someone else's private group. */
function hiddenGroupCheck(db: Db, me: Member) {
  const hidden = db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(isNotNull(groups.privateTo), ne(groups.privateTo, me.id)))
    .all();
  const ids = new Set(hidden.map((g) => g.id));
  const names = new Set(hidden.map((g) => g.name.toLowerCase()));
  return (detail: Record<string, unknown> | null) => {
    if (!detail) return false;
    if (typeof detail.groupId === 'string') return ids.has(detail.groupId);
    // Entries from before groups were recorded by id only have the name.
    const name = (detail.list ?? detail.name) as unknown;
    return typeof name === 'string' && names.has(name.toLowerCase());
  };
}

const listItems = (d: Record<string, unknown> | null) => (d?.items as string[] | undefined) ?? (typeof d?.item === 'string' ? [d.item] : []);

/**
 * Changes that read as one when the same person makes them back to back: edits to one task, and
 * several items added to or checked off one list.
 */
function mergeable(entry: Entry, row: Row['a'], detail: Record<string, unknown> | null) {
  if (entry.action !== row.action || entry.memberId !== row.memberId || entry.via !== row.via) return false;
  if (entry.oldest.a.createdAt.getTime() - row.createdAt.getTime() > MERGE_WINDOW_MS) return false;
  if (row.action === 'task.updated') return entry.taskId === row.taskId;
  if (row.action.startsWith('list.')) return entry.detail?.list === detail?.list;
  return false;
}

/** Folds an older change into the entry above it. */
function merge(entry: Entry, detail: Record<string, unknown> | null) {
  if (entry.action === 'task.updated') {
    const fields = new Set([...((entry.detail?.fields as string[]) ?? []), ...((detail?.fields as string[]) ?? [])]);
    entry.detail = { ...entry.detail, fields: [...fields] };
  } else {
    // Oldest first, so the list reads in the order things were added.
    const { item: _, outcome: __, ...rest } = entry.detail ?? {};
    entry.detail = { ...rest, items: [...listItems(detail), ...listItems(entry.detail)] };
  }
  entry.count++;
}

/**
 * What happened in the household, newest first, as this member is allowed to see it. Pass a task id
 * for one task's history, and `next` from a previous page as `before` to keep going.
 */
export function listActivity(db: Db, me: Member, opts: { taskId?: string; before?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const isHidden = hiddenGroupCheck(db, me);
  const out: Entry[] = [];
  let cursor = opts.before ? parseCursor(opts.before) : undefined;
  const batch = limit * 2;

  for (;;) {
    const rows: Row[] = db
      .select({ a: activity, seq, memberName: members.name, taskTitle: tasks.title })
      .from(activity)
      .leftJoin(members, eq(activity.memberId, members.id))
      .leftJoin(tasks, eq(activity.taskId, tasks.id))
      .leftJoin(taskGroups, eq(tasks.groupId, taskGroups.id))
      .where(
        and(
          opts.taskId ? eq(activity.taskId, opts.taskId) : undefined,
          cursor,
          or(isNull(activity.taskId), isNull(taskGroups.privateTo), eq(taskGroups.privateTo, me.id)),
        ),
      )
      .orderBy(desc(activity.createdAt), desc(seq))
      .limit(batch)
      .all();

    for (const row of rows) {
      const { a, memberName, taskTitle } = row;
      const detail = (a.detail as Record<string, unknown> | null) ?? null;
      if (!a.taskId && isHidden(detail)) continue;
      const last = out.at(-1);
      if (last && mergeable(last, a, detail)) {
        merge(last, detail);
        last.oldest = row;
        continue;
      }
      out.push({ ...entryOf(a, memberName, taskTitle, detail), oldest: row });
      // A new entry means the one before it can't grow any more, so a full page plus one is enough.
      if (out.length > limit) break;
    }
    if (out.length > limit || rows.length < batch) break;
    cursor = parseCursor(cursorOf(rows.at(-1)!));
  }

  const entries = out.slice(0, limit);
  const next = out.length > limit ? cursorOf(entries.at(-1)!.oldest) : null;
  return { entries: entries.map(({ oldest: _, ...e }) => e), next };
}

function entryOf(a: Row['a'], memberName: string | null, taskTitle: string | null, detail: Record<string, unknown> | null): ActivityEntry {
  return {
    id: a.id,
    at: a.createdAt,
    memberId: a.memberId,
    memberName,
    via: a.via,
    action: a.action,
    taskId: a.taskId,
    taskTitle,
    detail,
    count: 1,
  };
}

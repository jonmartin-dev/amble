// Changes show up the moment they're made, online or not: each one is applied to every cached
// view it touches (the day lists, the backlog, task pages, load bars, group counts, lists) while
// the outbox sends it. Once the server has it, the views refresh from the server's copy.
//
// The rules for which tasks land in which view mirror the server's (server/domain/tasks.ts and
// load.ts), so what shows offline is what the server would show.
import type { QueryClient } from '@tanstack/react-query';
import type { DayLoad, Group, HouseholdMember, ListItem, Session, Task, Today } from './api.ts';

const DEFAULT_ESTIMATE_MINUTES = 30;

type TasksData = { tasks: Task[] };
type ListData = { group: Group; open: ListItem[]; checked: ListItem[] };

function meId(qc: QueryClient) {
  return qc.getQueryData<Session>(['session'])?.member?.id ?? '';
}

// ---- finding ----------------------------------------------------------------------------------

/** The latest copy of a task in any cached view. */
export function findTask(qc: QueryClient, id: string): Task | undefined {
  const own = qc.getQueryData<{ task: Task }>(['task', id])?.task;
  if (own) return own;
  for (const [, day] of qc.getQueriesData<Today>({ queryKey: ['today'] })) {
    const hit = day && [...day.planned, ...day.carriedOver, ...day.due, ...day.done].find((t) => t.id === id);
    if (hit) return hit;
  }
  for (const [, data] of qc.getQueriesData<TasksData>({ queryKey: ['tasks'] })) {
    const hit = data?.tasks.find((t) => t.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function groupName(qc: QueryClient, id: string | null) {
  if (!id) return null;
  return qc.getQueryData<{ groups: Group[] }>(['groups'])?.groups.find((g) => g.id === id)?.name ?? null;
}

export function memberName(qc: QueryClient, id: string | null) {
  if (!id) return null;
  const session = qc.getQueryData<Session>(['session']);
  if (session?.member?.id === id) return session.member.name;
  return qc.getQueryData<{ members: HouseholdMember[] }>(['members'])?.members.find((m) => m.id === id)?.name ?? null;
}

// ---- ordering and matching (as the server does it) ---------------------------------------------

const cmp = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').localeCompare(b ?? '');

/** Must-do first, then by deadline (none last), then oldest first. */
function backlogOrder(a: Task, b: Task) {
  return (
    Number(b.mustDo) - Number(a.mustDo) ||
    Number(a.dueDate == null) - Number(b.dueDate == null) ||
    cmp(a.dueDate, b.dueDate) ||
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    cmp(a.createdAt, b.createdAt)
  );
}

/** Most recently finished (or changed) first. */
function recentOrder(a: Task, b: Task) {
  return cmp(b.completedAt ?? b.updatedAt, a.completedAt ?? a.updatedAt);
}

/** Their tasks plus shared ones; "everyone" is everything. */
function forWhom(t: Task, who: string, me: string) {
  if (who === 'everyone') return true;
  const id = who === 'me' ? me : who;
  return t.assigneeId == null || t.assigneeId === id;
}

/** Whether a task belongs in a `/api/tasks` result for these query params. */
function matchesTasks(t: Task, p: Record<string, string>, me: string) {
  const status = p.status === 'done' || p.status === 'all' ? p.status : 'open';
  if (status === 'all' ? t.status === 'archived' : t.status !== status) return false;
  if (p.group && t.groupId !== p.group) return false;
  if (p.q) {
    const hay = `${t.title} ${t.notes ?? ''}`.toLowerCase();
    if (!p.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  if (p.unplanned === '1' && t.plannedDate) return false;
  if (p.from && !(t.plannedDate && t.plannedDate >= p.from)) return false;
  if (p.to && !(t.plannedDate && t.plannedDate <= p.to)) return false;
  if (p.who) return forWhom(t, p.who, me);
  if (p.assignee === 'unassigned') return t.assigneeId == null;
  if (p.assignee) return t.assigneeId === p.assignee;
  return true;
}

/** When a planning day starts on this device: 4am, so 1am still counts as the day before. */
function dayStart(date: string) {
  return new Date(`${date}T04:00:00`).toISOString();
}

type Bucket = 'planned' | 'carriedOver' | 'due' | 'done';

function bucketFor(t: Task, today: string): Bucket | null {
  if (t.status === 'done') return t.completedAt && t.completedAt >= dayStart(today) ? 'done' : null;
  if (t.status !== 'open') return null;
  if (t.plannedDate === today) return 'planned';
  if (t.plannedDate && t.plannedDate < today) return 'carriedOver';
  if (t.dueDate && t.dueDate <= today && (!t.plannedDate || t.plannedDate > today)) return 'due';
  return null;
}

function loadLevel(minutes: number, capacity: number): DayLoad['level'] {
  if (capacity === 0) return minutes > 0 ? 'over' : 'light';
  const ratio = minutes / capacity;
  if (ratio < 0.5) return 'light';
  if (ratio < 0.85) return 'moderate';
  if (ratio <= 1) return 'full';
  return 'over';
}

/** Takes a task's share out of a day's load (`sign` -1) or adds it (+1). */
function shiftLoad(day: DayLoad, t: Task | null, person: string, sign: 1 | -1): DayLoad {
  if (!t || t.status !== 'open' || t.plannedDate !== day.date || (t.assigneeId != null && t.assigneeId !== person)) return day;
  const minutes = day.plannedMinutes + sign * (t.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES);
  return {
    ...day,
    tasks: day.tasks + sign,
    mustDo: day.mustDo + (t.mustDo ? sign : 0),
    guessed: day.guessed + (t.estimateMinutes == null ? sign : 0),
    plannedMinutes: minutes,
    level: loadLevel(minutes, day.capacityMinutes),
  };
}

const moveLoad = (day: DayLoad, before: Task | null, after: Task | null, person: string) =>
  shiftLoad(shiftLoad(day, before, person, -1), after, person, 1);

// ---- applying ---------------------------------------------------------------------------------

const VIEWS = new Set(['today', 'tasks', 'task', 'load', 'groups', 'list']);

/**
 * Drops reads of these views that are still on their way, so an answer from before this change
 * can't paint over it. They're read again once the change reaches the server.
 */
function holdReads(qc: QueryClient) {
  void qc.cancelQueries({ predicate: (q) => VIEWS.has(String(q.queryKey[0])) && q.state.fetchStatus === 'fetching' }, { revert: false, silent: true });
}

/** Swaps a task's old copy for its new one in a sorted list, adding or dropping it as it matches. */
function place(list: Task[], id: string, after: Task | null, order: (a: Task, b: Task) => number) {
  const rest = list.filter((t) => t.id !== id);
  return after ? [...rest, after].sort(order) : rest;
}

/**
 * Puts a task's new state (`after`, or null when it's gone) into every cached view, given the
 * state those views last had (`before`, or null for a new task).
 */
export function putTask(qc: QueryClient, before: Task | null, after: Task | null) {
  holdReads(qc);
  const id = (after ?? before)!.id;
  const me = meId(qc);

  if (after) qc.setQueryData<{ task: Task }>(['task', id], { task: after });

  for (const [key, data] of qc.getQueriesData<TasksData>({ queryKey: ['tasks'] })) {
    if (!data) continue;
    const params = (key[1] ?? {}) as Record<string, string>;
    const keep = after && matchesTasks(after, params, me) ? after : null;
    const had = data.tasks.some((t) => t.id === id);
    if (!keep && !had) continue;
    const order = params.status === 'done' ? recentOrder : backlogOrder;
    qc.setQueryData<TasksData>(key, { ...data, tasks: place(data.tasks, id, keep, order) });
  }

  for (const [key, day] of qc.getQueriesData<Today>({ queryKey: ['today'] })) {
    if (!day) continue;
    const who = (key[1] as string | undefined) ?? 'me';
    const bucket = after && forWhom(after, who, me) ? bucketFor(after, day.today) : null;
    const next = { ...day };
    for (const b of ['planned', 'carriedOver', 'due', 'done'] as const) {
      next[b] = place(day[b], id, b === bucket ? after : null, b === 'done' ? recentOrder : backlogOrder);
    }
    const person = who === 'me' || who === 'everyone' ? me : who;
    next.load = moveLoad(day.load, before, after, person);
    qc.setQueryData<Today>(key, next);
  }

  for (const [key, data] of qc.getQueriesData<{ days: DayLoad[] }>({ queryKey: ['load'] })) {
    if (!data) continue;
    const who = (key[3] as string | undefined) ?? 'me';
    const person = who === 'me' || who === 'everyone' ? me : who;
    qc.setQueryData(key, { ...data, days: data.days.map((d) => moveLoad(d, before, after, person)) });
  }

  // Group counts are open tasks per group, everyone's.
  const counts = new Map<string, number>();
  if (before?.status === 'open' && before.groupId) counts.set(before.groupId, -1);
  if (after?.status === 'open' && after.groupId) counts.set(after.groupId, (counts.get(after.groupId) ?? 0) + 1);
  if ([...counts.values()].some((n) => n !== 0)) {
    qc.setQueryData<{ groups: Group[] }>(['groups'], (data) =>
      data && { ...data, groups: data.groups.map((g) => (counts.has(g.id) ? { ...g, open: Math.max(0, g.open + counts.get(g.id)!) } : g)) },
    );
  }
}

/** Changes one task in place everywhere. Returns its state before and after, or null if it isn't cached. */
export function editTask(qc: QueryClient, id: string, change: (t: Task) => Partial<Task>) {
  const before = findTask(qc, id);
  if (!before) return null;
  const after: Task = { ...before, ...change(before), updatedAt: new Date().toISOString() };
  putTask(qc, before, after);
  return { before, after };
}

/** A whole new task as the server would return it, before the server has seen it. */
export function newTask(qc: QueryClient, fields: Partial<Task> & { id: string; title: string }): Task {
  const now = new Date().toISOString();
  const me = qc.getQueryData<Session>(['session'])?.member;
  const assigneeId = fields.assigneeId === undefined ? (me?.id ?? null) : fields.assigneeId;
  return {
    notes: null,
    groupId: null,
    dueDate: null,
    plannedDate: null,
    timeOfDay: null,
    mustDo: false,
    estimateMinutes: null,
    estimateSource: null,
    status: 'open',
    completedAt: null,
    handedBackNote: null,
    subtasks: [],
    links: [],
    repeat: null,
    pausedUntil: null,
    reminder: null,
    files: [],
    sortOrder: 0,
    ...fields,
    assigneeId,
    groupName: groupName(qc, fields.groupId ?? null),
    assigneeName: memberName(qc, assigneeId),
    createdById: me?.id ?? null,
    createdByName: me?.name ?? null,
    createdAt: now,
    updatedAt: now,
  };
}


// ---- lists ------------------------------------------------------------------------------------

function putListCount(qc: QueryClient, groupId: string, delta: number) {
  if (!delta) return;
  qc.setQueryData<{ groups: Group[] }>(['groups'], (data) =>
    data && { ...data, groups: data.groups.map((g) => (g.id === groupId ? { ...g, open: Math.max(0, g.open + delta) } : g)) },
  );
}

function editList(qc: QueryClient, groupId: string, change: (data: ListData) => ListData) {
  holdReads(qc);
  const data = qc.getQueryData<ListData>(['list', groupId]);
  if (!data) return;
  const next = change(data);
  qc.setQueryData(['list', groupId], next);
  putListCount(qc, groupId, next.open.length - data.open.length);
}

export type AddOutcome = 'added' | 'already on the list' | 'back on the list';

/**
 * Adds an item the way the server does: one already on the list is updated rather than repeated,
 * and one checked off before comes back.
 */
export function addListItem(qc: QueryClient, groupId: string, item: Partial<ListItem> & { id: string; name: string }): AddOutcome {
  let outcome: AddOutcome = 'added';
  const same = (i: ListItem) => i.name.toLowerCase() === item.name.toLowerCase();
  const details = Object.fromEntries(Object.entries(item).filter(([k, v]) => k !== 'id' && k !== 'name' && v !== undefined));
  editList(qc, groupId, (data) => {
    const open = data.open.find(same);
    if (open) {
      outcome = 'already on the list';
      return { ...data, open: data.open.map((i) => (i === open ? { ...i, ...details } : i)) };
    }
    const old = data.checked.find(same);
    if (old) {
      outcome = 'back on the list';
      return { ...data, open: [...data.open, { ...old, ...details, checkedAt: null }], checked: data.checked.filter((i) => i !== old) };
    }
    const fresh: ListItem = { quantity: null, note: null, section: null, url: null, price: null, ...item, groupId, checkedAt: null };
    return { ...data, open: [...data.open, fresh] };
  });
  return outcome;
}

export function checkListItem(qc: QueryClient, groupId: string, itemId: string, checked: boolean) {
  editList(qc, groupId, (data) => {
    if (checked) {
      const item = data.open.find((i) => i.id === itemId);
      if (!item) return data;
      return { ...data, open: data.open.filter((i) => i !== item), checked: [{ ...item, checkedAt: new Date().toISOString() }, ...data.checked] };
    }
    const item = data.checked.find((i) => i.id === itemId);
    if (!item) return data;
    return { ...data, open: [...data.open, { ...item, checkedAt: null }], checked: data.checked.filter((i) => i !== item) };
  });
}

export function editListItem(qc: QueryClient, groupId: string, itemId: string, patch: Partial<ListItem>) {
  const apply = (i: ListItem) => (i.id === itemId ? { ...i, ...patch } : i);
  editList(qc, groupId, (data) => ({ ...data, open: data.open.map(apply), checked: data.checked.map(apply) }));
}

/** Puts everything checked back on the list. Returns how many came back. */
export function resetListItems(qc: QueryClient, groupId: string) {
  let count = 0;
  editList(qc, groupId, (data) => {
    count = data.checked.length;
    return { ...data, open: [...data.open, ...data.checked.map((i) => ({ ...i, checkedAt: null }))], checked: [] };
  });
  return count;
}

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, type Member, type Repeat, type Session, type Task, type TimeOfDay } from './api.ts';
import { dayLabel, reminderPhrase, todayIso } from './dates.ts';
import { editTask, findTask, groupName, memberName, newTask, putTask } from './local.ts';
import { useSnackbar } from './snackbar.tsx';
import { queue } from './sync.ts';

export interface NewTask {
  title: string;
  notes?: string | null;
  groupId?: string | null;
  assigneeId?: string | null;
  dueDate?: string | null;
  plannedDate?: string | null;
  timeOfDay?: TimeOfDay | null;
  mustDo?: boolean;
  estimateMinutes?: number | null;
  /** The list it's a trip for, like Groceries for a grocery run. */
  listId?: string | null;
}

export type TaskPatch = Partial<Omit<NewTask, 'assigneeId' | 'listId'>> & {
  addSubtasks?: string[];
  checkSubtasks?: string[];
  uncheckSubtasks?: string[];
  removeSubtasks?: string[];
  addLinks?: { url: string }[];
  removeLinks?: string[];
  repeat?: Repeat | null;
  pausedUntil?: string | null;
  /** Your reminder: an ISO time, or null to clear it. */
  remindAt?: string | null;
};

const post = <T,>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });

/** Every view a task change can touch, refreshed from the server once it has the change. */
export const TASK_VIEWS = ['today', 'tasks', 'task', 'load', 'groups', 'activity', 'stats', 'list', 'session', 'capacity', 'ai', 'briefing', 'gaps', 'reminders'];

export function refreshViews(qc: QueryClient, keys = TASK_VIEWS) {
  for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
}

/**
 * Hands a change to the outbox, which sends it now or once there's a connection. If this device
 * can't store it (no IndexedDB), it's sent straight away instead.
 */
export function useSend() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  return (method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, label: string) => {
    const memberId = qc.getQueryData<Session>(['session'])?.member?.id;
    if (!memberId) return;
    queue({ memberId, method, path, body, label }).catch(() =>
      api(path, { method, body: JSON.stringify(body) }).then(
        () => refreshViews(qc),
        (e: Error) => {
          snack({ message: e.message });
          refreshViews(qc);
        },
      ),
    );
  };
}

/** Saves the signed-in person's own settings: on screen at once, then to the server through the outbox. */
export function useSaveMe() {
  const qc = useQueryClient();
  const send = useSend();
  return (patch: Partial<Pick<Member, 'theme' | 'capacity' | 'showStreaks' | 'smartAdd'>>, label: string) => {
    qc.setQueryData<Session>(['session'], (s) => (s?.member ? { ...s, member: { ...s.member, ...patch } } : s));
    send('PATCH', '/me', patch, label);
  };
}

/** A patch as it lands on a cached task; new steps and links get ids here so later changes can name them. */
function patched(qc: QueryClient, t: Task, patch: TaskPatch, steps: { id: string; title: string }[], links: { id: string; url: string }[]): Partial<Task> {
  const scalar = Object.fromEntries(
    Object.entries(patch).filter(([k]) => !['addSubtasks', 'checkSubtasks', 'uncheckSubtasks', 'removeSubtasks', 'addLinks', 'removeLinks', 'remindAt'].includes(k)),
  ) as Partial<Task>;
  const checked = new Set(patch.checkSubtasks ?? []);
  const unchecked = new Set(patch.uncheckSubtasks ?? []);
  const removed = new Set(patch.removeSubtasks ?? []);
  const gone = new Set(patch.removeLinks ?? []);
  return {
    ...scalar,
    ...(patch.groupId !== undefined && { groupName: groupName(qc, patch.groupId) }),
    ...(patch.estimateMinutes !== undefined && { estimateSource: patch.estimateMinutes == null ? null : 'user' }),
    ...(patch.remindAt !== undefined && { reminder: patch.remindAt ? { id: t.reminder?.id ?? 'pending', at: patch.remindAt, sentAt: null } : null }),
    subtasks: [
      ...t.subtasks
        .filter((s) => !removed.has(s.id))
        .map((s) => (checked.has(s.id) ? { ...s, done: true } : unchecked.has(s.id) ? { ...s, done: false } : s)),
      ...steps.map((s) => ({ ...s, done: false })),
    ],
    links: [...t.links.filter((l) => !gone.has(l.id)), ...links.map((l) => ({ ...l, title: null }))],
  };
}

/**
 * Every task change. Each shows at once in every view (local.ts) and goes out through the outbox,
 * so it works the same offline. Completing, moving and removing offer Undo. Confirmations live
 * here, not on the screen that started them, so they still appear when that screen has gone away
 * (a swiped row, a closed task page).
 */
export function useTaskActions() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const send = useSend();

  const create = (t: NewTask) => {
    const id = crypto.randomUUID();
    const task = newTask(qc, { ...t, id, estimateSource: t.estimateMinutes != null ? 'user' : null });
    putTask(qc, null, task);
    send('POST', '/tasks', { ...t, id }, `Add ${t.title}`);
    return task;
  };

  const update = (id: string, patch: TaskPatch) => {
    const steps = (patch.addSubtasks ?? []).map((title) => ({ id: crypto.randomUUID(), title }));
    const links = (patch.addLinks ?? []).map((l) => ({ id: crypto.randomUUID(), url: l.url }));
    const change = editTask(qc, id, (t) => patched(qc, t, patch, steps, links));
    const body = { ...patch, ...(steps.length && { addSubtasks: steps }), ...(links.length && { addLinks: links }) };
    send('PATCH', `/tasks/${id}`, body, `Change ${change?.before.title ?? 'a task'}`);
  };

  /** Sets or clears your reminder, saying when it'll come. */
  const remind = (task: Task, at: Date | null) => {
    update(task.id, { remindAt: at ? at.toISOString() : null });
    snack({
      message: at ? `I'll remind you ${reminderPhrase(at)}` : 'Reminder cleared',
      action: { label: 'Undo', run: () => update(task.id, { remindAt: task.reminder && !task.reminder.sentAt ? task.reminder.at : null }) },
    });
  };

  const assign = (id: string, assigneeId: string | null, note?: string | null) => {
    const change = editTask(qc, id, () => ({ assigneeId, assigneeName: memberName(qc, assigneeId), handedBackNote: note?.trim() || null }));
    send('POST', `/tasks/${id}/assign`, { assigneeId, note }, `Hand over ${change?.before.title ?? 'a task'}`);
  };

  const setDone = (task: Task, done: boolean) => {
    editTask(qc, task.id, () => (done ? { status: 'done', completedAt: new Date().toISOString() } : { status: 'open', completedAt: null }));
    send('POST', `/tasks/${task.id}/complete`, { done }, `${done ? 'Finish' : 'Reopen'} ${task.title}`);
  };

  const complete = (task: Task, done = task.status !== 'done') => {
    setDone(task, done);
    if (done) snack({ message: `Done: ${task.title}`, action: { label: 'Undo', run: () => setDone(task, false) } });
  };

  const setPlanned = (task: Task, plannedDate: string | null) => {
    editTask(qc, task.id, () => ({ plannedDate }));
    send('POST', `/tasks/${task.id}/move`, { plannedDate }, `Move ${task.title}`);
  };

  const moveAll = (tasks: Task[], plannedDate: string | null, today: string) => {
    // Undo puts each back where it was, from the copy on screen when it was moved.
    const was = tasks.map((t) => findTask(qc, t.id) ?? t);
    for (const t of was) setPlanned(t, plannedDate);
    const where = plannedDate ? dayLabel(plannedDate, today, true) : 'the backlog';
    snack({
      message: tasks.length === 1 ? `Moved to ${where}` : `Moved ${tasks.length} tasks to ${where}`,
      action: { label: 'Undo', run: () => was.forEach((t) => setPlanned(t, t.plannedDate)) },
    });
  };

  /** Plans several tasks, each on its own day, with one Undo for all of them. */
  const planAll = (picks: { task: Task; date: string }[]) => {
    if (picks.length === 0) return;
    const was = picks.map((p) => findTask(qc, p.task.id) ?? p.task);
    picks.forEach((p, i) => setPlanned(was[i]!, p.date));
    snack({
      message: picks.length === 1 ? `Planned ${picks[0]!.task.title}` : `Planned ${picks.length} tasks`,
      action: { label: 'Undo', run: () => was.forEach((t) => setPlanned(t, t.plannedDate)) },
    });
  };

  const setArchived = (task: Task, archived: boolean) => {
    editTask(qc, task.id, (t) => ({ status: archived ? 'archived' : t.completedAt ? 'done' : 'open' }));
    send('POST', `/tasks/${task.id}/archive`, archived ? {} : { restore: true }, `${archived ? 'Remove' : 'Restore'} ${task.title}`);
  };

  const archive = (task: Task) => {
    setArchived(task, true);
    snack({ message: `Removed ${task.title}`, action: { label: 'Undo', run: () => setArchived(task, false) } });
  };

  // Skipping works out the next date from the repeat rule, which only the server knows how to do.
  const skip = useMutation({
    mutationFn: (task: Task) => post<{ task: Task }>(`/tasks/${task.id}/skip`, {}).then((r) => r.task),
    onSuccess: (next, task) => {
      putTask(qc, findTask(qc, task.id) ?? task, next);
      snack({
        message: `Skipped. Next one ${next.plannedDate ?? next.dueDate ? dayLabel((next.plannedDate ?? next.dueDate)!, todayIso(), true) : 'later'}`,
        action: { label: 'Undo', run: () => update(task.id, { plannedDate: task.plannedDate, dueDate: task.dueDate }) },
      });
    },
    onError: (e: Error) =>
      snack({ message: e instanceof ApiError && e.status === 0 ? "Skipping needs a connection. Try again once you're online." : e.message }),
    onSettled: () => refreshViews(qc),
  });

  return {
    create,
    update,
    remind,
    assign,
    complete,
    move: (task: Task, plannedDate: string | null, today: string) => moveAll([task], plannedDate, today),
    moveAll,
    planAll,
    archive,
    skip: (task: Task) => skip.mutate(task),
  };
}

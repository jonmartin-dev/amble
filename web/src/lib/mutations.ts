import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Task, type TimeOfDay } from './api.ts';
import { dayLabel } from './dates.ts';
import { useSnackbar } from './snackbar.tsx';

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
}

export type TaskPatch = Partial<Omit<NewTask, 'assigneeId'>> & {
  addSubtasks?: string[];
  checkSubtasks?: string[];
  uncheckSubtasks?: string[];
  removeSubtasks?: string[];
  addLinks?: { url: string }[];
  removeLinks?: string[];
};

const post = <T,>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });

interface MoveVars {
  tasks: Task[];
  plannedDate: string | null;
  today: string;
}

/**
 * Every task change, each refreshing the views it touches. Completing, moving and removing offer
 * Undo. Confirmations live on the mutations themselves, not on the screen that started them, so
 * they still appear when that screen has gone away (a swiped row, a closed task page).
 */
export function useTaskActions() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const refresh = () => {
    for (const key of ['today', 'tasks', 'task', 'load', 'groups']) void qc.invalidateQueries({ queryKey: [key] });
  };
  const fail = (e: Error) => snack({ message: e.message });
  const undo = (calls: Promise<unknown>[]) => void Promise.all(calls).then(refresh, fail);
  const opts = { onSettled: refresh, onError: fail };

  const create = useMutation({ mutationFn: (t: NewTask) => post<{ task: Task }>('/tasks', t).then((r) => r.task), ...opts });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) =>
      api<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.task),
    ...opts,
  });
  const assign = useMutation({
    mutationFn: ({ id, assigneeId, note }: { id: string; assigneeId: string | null; note?: string | null }) =>
      post<{ task: Task }>(`/tasks/${id}/assign`, { assigneeId, note }).then((r) => r.task),
    ...opts,
  });

  const complete = useMutation({
    mutationFn: ({ task, done }: { task: Task; done: boolean }) => post(`/tasks/${task.id}/complete`, { done }),
    onSuccess: (_, { task, done }) => {
      if (done) {
        snack({
          message: `Done: ${task.title}`,
          action: { label: 'Undo', run: () => undo([post(`/tasks/${task.id}/complete`, { done: false })]) },
        });
      }
    },
    ...opts,
  });

  const move = useMutation({
    mutationFn: ({ tasks, plannedDate }: MoveVars) => Promise.all(tasks.map((t) => post(`/tasks/${t.id}/move`, { plannedDate }))),
    onSuccess: (_, { tasks, plannedDate, today }) => {
      const where = plannedDate ? dayLabel(plannedDate, today, true) : 'the backlog';
      snack({
        message: tasks.length === 1 ? `Moved to ${where}` : `Moved ${tasks.length} tasks to ${where}`,
        action: {
          label: 'Undo',
          run: () => undo(tasks.map((t) => post(`/tasks/${t.id}/move`, { plannedDate: t.plannedDate }))),
        },
      });
    },
    ...opts,
  });

  const archive = useMutation({
    mutationFn: (task: Task) => post(`/tasks/${task.id}/archive`, {}),
    onSuccess: (_, task) =>
      snack({
        message: `Removed ${task.title}`,
        action: { label: 'Undo', run: () => undo([post(`/tasks/${task.id}/archive`, { restore: true })]) },
      }),
    ...opts,
  });

  return {
    create,
    update,
    assign,
    complete: (task: Task, done = task.status !== 'done') => complete.mutate({ task, done }),
    move: (task: Task, plannedDate: string | null, today: string) => move.mutate({ tasks: [task], plannedDate, today }),
    moveAll: (tasks: Task[], plannedDate: string | null, today: string) => move.mutate({ tasks, plannedDate, today }),
    archive: (task: Task) => archive.mutate(task),
  };
}

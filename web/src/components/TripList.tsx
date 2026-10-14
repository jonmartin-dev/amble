// What a trip task (a grocery run) shows of its list: which one, and how much is left on it.
import { Link } from '@tanstack/react-router';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import type { Task } from '../lib/api.ts';
import { useGroups } from '../lib/queries.ts';
import { GroupIcon, tone } from './icons.tsx';

function left(n: number) {
  return n ? `${n} left` : 'Nothing left';
}

/** On a task's row: the list's name and what's left, from the copy of the lists on the phone. */
export function TripBadge({ task }: { task: Task }) {
  const { data: groups = [] } = useGroups();
  const list = groups.find((g) => g.id === task.listId);
  if (!list) return null;
  return (
    <span className="flex items-center gap-1">
      <GroupIcon name={list.icon} className="size-4" />
      {left(list.open)}
    </span>
  );
}

/** On a task's page: the list to open, with what's left on it. */
export function TripCard({ task }: { task: Task }) {
  const { data: groups = [] } = useGroups();
  const list = groups.find((g) => g.id === task.listId);
  if (!list) return null;
  return (
    <Link
      to="/list/$groupId"
      params={{ groupId: list.id }}
      className="press-soft mt-4 flex items-center gap-3 rounded-3xl bg-surface-low py-3 pr-3 pl-3.5 transition-colors hover:bg-surface-container"
    >
      <span className={`grid size-11 shrink-0 place-items-center rounded-[1.1rem] ${tone(list.color)}`}>
        <GroupIcon name={list.icon} className="size-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{list.name}</span>
        <span className="block text-sm text-on-surface-variant">{left(list.open)} on the list</span>
      </span>
      <ChevronRight className="size-6 text-on-surface-variant" aria-hidden />
    </Link>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import DragIndicator from '~icons/material-symbols/drag-indicator-rounded';
import { GroupSheet } from '../components/GroupSheet.tsx';
import { GroupIcon, tone } from '../components/icons.tsx';
import { SectionTitle, segment, SubpageHeader } from '../components/ui.tsx';
import { api, type Group } from '../lib/api.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { useArchivedGroups, useGroups } from '../lib/queries.ts';

function GroupRow({
  group,
  index,
  count,
  onEdit,
  onNudge,
  onDrop,
}: {
  group: Group;
  index: number;
  count: number;
  onEdit: () => void;
  onNudge: (by: number) => void;
  onDrop: () => void;
}) {
  const controls = useDragControls();
  const detail = group.kind === 'list' ? `${group.open} ${group.open === 1 ? 'item' : 'items'}` : `${group.open} open`;
  return (
    <Reorder.Item
      value={group}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className={`relative flex items-center gap-1 bg-surface-low py-2 pr-2 pl-1 ${segment(index, count)}`}
      whileDrag={{ scale: 1.02, boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)', zIndex: 1 }}
    >
      <button
        type="button"
        aria-label={`Reorder ${group.name}. Use the arrow keys to move it.`}
        onPointerDown={(e) => controls.start(e)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onNudge(e.key === 'ArrowUp' ? -1 : 1);
          }
        }}
        className="grid size-11 shrink-0 cursor-grab touch-none place-items-center rounded-full text-on-surface-variant active:cursor-grabbing"
      >
        <DragIndicator className="size-6" aria-hidden />
      </button>
      <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-1 text-left">
        <span className={`grid size-10 shrink-0 place-items-center rounded-2xl ${tone(group.color)}`}>
          <GroupIcon name={group.icon} className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{group.name}</span>
          <span className="block text-sm text-on-surface-variant">
            {detail}
            {group.privateTo ? ' · Only you' : ''}
          </span>
        </span>
        <ChevronRight className="size-6 shrink-0 text-on-surface-variant" aria-hidden />
      </button>
    </Reorder.Item>
  );
}

/** Rename, recolor, reorder and archive groups and lists. Order here is the order everywhere. */
export function GroupsSettings() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { data: groups } = useGroups();
  const { data: archived } = useArchivedGroups();
  const [taskGroups, setTaskGroups] = useState<Group[]>([]);
  const [lists, setLists] = useState<Group[]>([]);
  const [editing, setEditing] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!groups) return;
    setTaskGroups(groups.filter((g) => g.kind === 'tasks'));
    setLists(groups.filter((g) => g.kind === 'list'));
  }, [groups]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['groups'] });
  const onError = (e: Error) => {
    snack({ message: e.message });
    refresh();
  };
  const order = useMutation({
    mutationFn: (ids: string[]) => api('/groups/order', { method: 'POST', body: JSON.stringify({ ids }) }),
    onError,
    onSettled: refresh,
  });
  const restore = useMutation({
    mutationFn: (g: Group) => api(`/groups/${g.id}/archive`, { method: 'POST', body: JSON.stringify({ restore: true }) }),
    onSuccess: (_, g) => snack({ message: `${g.name} is back` }),
    onError,
    onSettled: () => {
      for (const key of ['groups', 'tasks', 'today', 'activity']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });

  // Lists show first in the backlog, so they come first in the saved order too.
  const saveOrder = (t = taskGroups, l = lists) => order.mutate([...l, ...t].map((g) => g.id));
  const nudge = (items: Group[], set: (g: Group[]) => void, isList: boolean) => (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set(next);
    if (isList) saveOrder(taskGroups, next);
    else saveOrder(next, lists);
  };

  const section = (title: string, items: Group[], set: (g: Group[]) => void, isList: boolean) =>
    items.length > 0 && (
      <>
        <SectionTitle>{title}</SectionTitle>
        <Reorder.Group axis="y" values={items} onReorder={set} className="flex flex-col gap-0.5">
          {items.map((g, i) => (
            <GroupRow
              key={g.id}
              group={g}
              index={i}
              count={items.length}
              onEdit={() => setEditing(g)}
              onNudge={(by) => nudge(items, set, isList)(i, by)}
              onDrop={() => saveOrder()}
            />
          ))}
        </Reorder.Group>
      </>
    );

  return (
    <>
      <SubpageHeader title="Groups and lists" />
      <p className="px-1 text-on-surface-variant">Drag to change the order they appear in. Tap one to rename, recolor or archive it.</p>

      {section('Lists', lists, setLists, true)}
      {section('Groups', taskGroups, setTaskGroups, false)}

      <button
        type="button"
        onClick={() => setCreating(true)}
        className="mt-4 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high"
      >
        <Add className="size-5" aria-hidden />
        New group or list
      </button>

      {archived && archived.length > 0 && (
        <>
          <SectionTitle>Archived</SectionTitle>
          <ul className="flex flex-col gap-0.5">
            {archived.map((g, i) => (
              <li key={g.id} className={`flex items-center gap-3 bg-surface-low py-2 pr-2 pl-3 ${segment(i, archived.length)}`}>
                <span className={`grid size-10 shrink-0 place-items-center rounded-2xl opacity-60 ${tone(g.color)}`}>
                  <GroupIcon name={g.icon} className="size-5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-on-surface-variant">{g.name}</span>
                <button
                  type="button"
                  onClick={() => restore.mutate(g)}
                  className="rounded-full px-3 py-2 text-sm font-medium text-primary hover:bg-surface-high"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <GroupSheet open={editing != null || creating} group={editing} onClose={() => (setEditing(null), setCreating(false))} />
    </>
  );
}

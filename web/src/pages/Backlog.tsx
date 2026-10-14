import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import Search from '~icons/material-symbols/search-rounded';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import { OrganizeSheet } from '../components/OrganizeSheet.tsx';
import { GroupIcon, tone } from '../components/icons.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { GroupSheet } from '../components/GroupSheet.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { Chip, SectionTitle } from '../components/ui.tsx';
import type { Group, Task } from '../lib/api.ts';
import { todayIso } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useAi, useGroups, useMe, useTasks } from '../lib/queries.ts';
import { useSyncState } from '../lib/sync.ts';

function GroupSection({
  group,
  tasks,
  render,
}: {
  group: Pick<Group, 'name' | 'icon' | 'color'>;
  tasks: Task[];
  render: (t: Task) => React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-3xl px-1 py-2 text-left"
      >
        <span className={`grid size-10 place-items-center rounded-2xl ${tone(group.color)}`}>
          <GroupIcon name={group.icon} className="size-5" />
        </span>
        <span className="flex-1 font-medium">{group.name}</span>
        <span className="text-sm text-on-surface-variant">{tasks.length}</span>
        <motion.span animate={{ rotate: open ? 0 : -90 }} transition={expressive.fastSpatial}>
          <ExpandMore className="size-6 text-on-surface-variant" aria-hidden />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={expressive.defaultSpatial}
            className="flex flex-col gap-2 overflow-hidden pt-1"
          >
            <AnimatePresence initial={false}>
              {tasks.map((t) => (
                <motion.li key={t.id} layout exit={{ opacity: 0, height: 0 }} transition={expressive.defaultSpatial}>
                  {render(t)}
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
  );
}

export function Backlog() {
  const me = useMe();
  const { data: groups } = useGroups();
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState(false);
  const [unplanned, setUnplanned] = useState(false);
  const [moving, setMoving] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [tidying, setTidying] = useState(false);
  const { data: ai } = useAi();
  const { online } = useSyncState();
  const params: Record<string, string> = {};
  if (query.trim()) params.q = query.trim();
  if (mine && me) params.assignee = me.id;
  if (unplanned) params.unplanned = '1';
  const { data: tasks } = useTasks(params);
  const today = todayIso();

  const render = (t: Task) => <TaskRow task={t} today={today} meId={me?.id ?? ''} onMove={setMoving} showDay showGroup={false} />;
  const lists = groups?.filter((g) => g.kind === 'list') ?? [];
  const taskGroups = groups?.filter((g) => g.kind === 'tasks') ?? [];
  const ungrouped = tasks?.filter((t) => !t.groupId) ?? [];
  const filtering = Boolean(query.trim() || mine || unplanned);

  return (
    <>
      <PageHeader title="Backlog" />

      <label className="flex items-center gap-3 rounded-full bg-surface-high px-4 py-3">
        <Search className="size-5 text-on-surface-variant" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks"
          aria-label="Search tasks"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-on-surface-variant"
        />
      </label>
      <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
        <Chip selected={mine} onClick={() => setMine((v) => !v)}>
          Just mine
        </Chip>
        <Chip selected={unplanned} onClick={() => setUnplanned((v) => !v)}>
          Not planned yet
        </Chip>
        {ai?.available && online && (tasks?.length ?? 0) > 1 && !filtering && (
          <Chip onClick={() => setTidying(true)} icon={<Sparkle className="size-4" aria-hidden />}>
            Tidy up
          </Chip>
        )}
      </div>

      {lists.length > 0 && !filtering && (
        <>
          <SectionTitle>Lists</SectionTitle>
          <ul className="flex flex-col gap-2">
            {lists.map((g) => (
              <li key={g.id}>
                <Link
                  to="/list/$groupId"
                  params={{ groupId: g.id }}
                  className="flex items-center gap-4 rounded-3xl bg-surface-low p-3 pr-4 transition-colors hover:bg-surface-container"
                >
                  <span className={`grid size-12 place-items-center rounded-2xl ${tone(g.color)}`}>
                    <GroupIcon name={g.icon} className="size-6" />
                  </span>
                  <span className="flex-1">
                    <span className="block font-medium">{g.name}</span>
                    <span className="block text-sm text-on-surface-variant">
                      {g.open === 0 ? 'Nothing on it' : `${g.open} ${g.open === 1 ? 'item' : 'items'}`}
                    </span>
                  </span>
                  <ChevronRight className="size-6 text-on-surface-variant" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionTitle>Tasks</SectionTitle>
      {tasks && tasks.length === 0 && (
        <p className="rounded-3xl bg-surface-low p-5 text-on-surface-variant">
          {filtering ? 'Nothing matches.' : 'The backlog is empty. Add something with the plus button.'}
        </p>
      )}
      {taskGroups.map((g) => {
        const inGroup = tasks?.filter((t) => t.groupId === g.id) ?? [];
        return inGroup.length > 0 && <GroupSection key={g.id} group={g} tasks={inGroup} render={render} />;
      })}
      {ungrouped.length > 0 && <GroupSection group={{ name: 'No group', icon: 'folder', color: 'teal' }} tasks={ungrouped} render={render} />}

      <button
        type="button"
        onClick={() => setCreating(true)}
        className="mt-6 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high"
      >
        <Add className="size-5" aria-hidden />
        New group or list
      </button>

      <MoveSheet task={moving} today={today} onClose={() => setMoving(null)} />
      <GroupSheet open={creating} onClose={() => setCreating(false)} />
      <OrganizeSheet open={tidying} onClose={() => setTidying(false)} />
    </>
  );
}

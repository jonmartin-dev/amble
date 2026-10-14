import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import { GroupIcon, tone } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useGroups } from '../lib/queries.ts';

export function Backlog() {
  const { data: groups, isPending } = useGroups();

  return (
    <>
      <PageHeader title="Backlog" />
      {isPending ? (
        <p className="text-on-surface-variant">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups?.map((g) => (
            <li key={g.id} className="flex items-center gap-4 rounded-3xl bg-surface-low p-3 pr-5">
              <span className={`grid size-12 place-items-center rounded-2xl ${tone(g.color)}`}>
                <GroupIcon name={g.icon} className="size-6" />
              </span>
              <div className="flex-1">
                <p className="font-medium">{g.name}</p>
                <p className="text-sm text-on-surface-variant">{g.kind === 'list' ? 'List · empty' : 'No tasks yet'}</p>
              </div>
              <ExpandMore className="size-6 text-on-surface-variant" aria-hidden />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

import { GroupIcon, tone } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { firstName, longDate, planningDate } from '../lib/dates.ts';
import { useGroups, useMe } from '../lib/queries.ts';

export function Today() {
  const me = useMe();
  const { data: groups } = useGroups();

  return (
    <>
      <PageHeader eyebrow={longDate(planningDate())} title={`Here's today, ${firstName(me?.name ?? '')}`} />

      <section className="rounded-[2rem] bg-primary-container p-5 text-on-primary-container">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm">Today's load</h2>
          <p className="display text-2xl font-medium">Wide open</p>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-on-primary-container/15">
          <div className="h-full w-[4%] rounded-full bg-primary" />
        </div>
        <p className="mt-3 text-sm">Nothing planned yet. Add a task with the plus button, or pull one in from your backlog.</p>
      </section>

      <h2 className="mt-8 mb-3 px-1 text-sm font-medium text-primary">Your groups</h2>
      <ul className="flex flex-wrap gap-2">
        {groups?.map((g) => (
          <li key={g.id} className={`flex items-center gap-2 rounded-full py-2 pr-4 pl-3 ${tone(g.color)}`}>
            <GroupIcon name={g.icon} className="size-5" />
            {g.name}
          </li>
        ))}
      </ul>
    </>
  );
}

import { ActivityRow } from '../components/ActivityList.tsx';
import { SectionTitle, SubpageHeader } from '../components/ui.tsx';
import type { ActivityEntry } from '../lib/api.ts';
import { dayLabel, fullDate, isoDate, todayIso } from '../lib/dates.ts';
import { useActivity, useMe, useMembers } from '../lib/queries.ts';

/** Everything that changed in the household, newest first, grouped by day. */
export function Activity() {
  const me = useMe();
  const { data: household } = useMembers();
  const feed = useActivity();
  const today = todayIso();
  const entries = feed.data?.pages.flatMap((p) => p.entries) ?? [];
  const days: { date: string; entries: ActivityEntry[] }[] = [];
  for (const e of entries) {
    const date = isoDate(new Date(e.at));
    if (days.at(-1)?.date !== date) days.push({ date, entries: [] });
    days.at(-1)!.entries.push(e);
  }
  const ctx = { meId: me?.id ?? '', members: household?.members ?? [], today };

  return (
    <>
      <SubpageHeader title="Activity" back="/" />
      <p className="px-1 text-on-surface-variant">What changed in the household, and who changed it. Claude's changes say so.</p>

      {feed.data && entries.length === 0 && (
        <p className="mt-6 rounded-3xl bg-surface-low p-5 text-on-surface-variant">Nothing yet. Changes show up here as people add and finish things.</p>
      )}

      {days.map((d) => {
        const label = dayLabel(d.date, today);
        return (
          <section key={d.date}>
            <SectionTitle>{['Today', 'Yesterday'].includes(label) ? label : fullDate(d.date)}</SectionTitle>
            <ul className="rounded-[1.75rem] bg-surface-low px-4 py-1">
              {d.entries.map((e) => (
                <ActivityRow key={e.id} entry={e} ctx={ctx} />
              ))}
            </ul>
          </section>
        );
      })}

      {feed.hasNextPage && (
        <button
          type="button"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetchingNextPage}
          className="mt-5 w-full rounded-full bg-surface-high py-3 text-sm font-medium disabled:opacity-60"
        >
          {feed.isFetchingNextPage ? 'Loading…' : 'Show earlier'}
        </button>
      )}
    </>
  );
}

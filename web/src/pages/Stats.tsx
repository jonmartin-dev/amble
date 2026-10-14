import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Avatar } from '../components/Avatar.tsx';
import { GroupIcon, tone } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import type { Stats as StatsData, TimeOfDayBucket } from '../lib/api.ts';
import { firstName, monthShort, shortDate, weekdayName } from '../lib/dates.ts';
import { useStats } from '../lib/queries.ts';

const PALETTE = ['green', 'blue', 'orange', 'violet', 'rose', 'teal', 'lime'];

/** One chart color per person, from their own color unless someone already has it. */
function seriesColors(members: StatsData['members']) {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const m of members) {
    const color = used.has(m.color) ? (PALETTE.find((p) => !used.has(p)) ?? m.color) : m.color;
    used.add(color);
    out.set(m.id, `var(--tone-${color}-base)`);
  }
  return out;
}

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="mt-3 rounded-[2rem] bg-surface-low p-5">
      <h2 className="text-sm font-medium text-primary">{title}</h2>
      <div className="mt-3">{children}</div>
      {footer && <p className="mt-3 text-sm text-on-surface-variant">{footer}</p>}
    </section>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Weekly({ data, colors }: { data: StatsData; colors: Map<string, string> }) {
  const max = Math.max(1, ...data.weeks.map((w) => w.total));
  const order = [...data.members.map((m) => m.id), 'unknown'];
  return (
    <>
      <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`Tasks done each week for the last ${data.weeks.length} weeks`}>
        {data.weeks.map((w, i) => (
          <div key={w.start} className="flex h-full flex-1 flex-col justify-end" title={`Week of ${shortDate(w.start)}: ${w.total}`}>
            <div
              className="grow-up flex flex-col-reverse overflow-hidden rounded-lg"
              style={{ height: `${(w.total / max) * 100}%`, animationDelay: `${i * 20}ms` }}
            >
              {order.map((id) =>
                w.byMember[id] ? (
                  <span key={id} style={{ flexGrow: w.byMember[id], background: colors.get(id) ?? 'var(--color-outline)' }} className="block min-h-1" />
                ) : null,
              )}
            </div>
            {w.total === 0 && <span className="block h-1 rounded-full bg-surface-highest" />}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-on-surface-variant">
        <span>{shortDate(data.weeks[0]!.start)}</span>
        <span>This week</span>
      </div>
      {data.members.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {data.members.map((m) => (
            <span key={m.id} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: colors.get(m.id) }} />
              {firstName(m.name)}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function Weekdays({ data }: { data: StatsData }) {
  const max = Math.max(1, ...data.weekdays.map((d) => d.count));
  const top = data.weekdays.reduce((a, b) => (b.count > a.count ? b : a));
  return (
    <div className="flex h-28 items-end gap-2">
      {data.weekdays.map((d, i) => (
        <div key={d.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <span
            className={`grow-up w-full max-w-8 rounded-lg ${d.day === top.day && top.count > 0 ? 'bg-primary' : 'bg-primary/40'}`}
            style={{ height: `${Math.max((d.count / max) * 100, d.count ? 6 : 3)}%`, animationDelay: `${i * 30}ms` }}
          />
          <span className="text-xs text-on-surface-variant">{weekdayName(d.day, 'narrow')}</span>
        </div>
      ))}
    </div>
  );
}

const timeWords: Record<TimeOfDayBucket, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night' };
const timeFills: Record<TimeOfDayBucket, string> = {
  morning: 'var(--tone-orange-base)',
  afternoon: 'var(--tone-lime-base)',
  evening: 'var(--tone-violet-base)',
  night: 'var(--tone-blue-base)',
};

function TimesOfDay({ data }: { data: StatsData }) {
  const total = data.timesOfDay.reduce((n, t) => n + t.count, 0) || 1;
  return (
    <>
      <div className="grow-right flex h-4 gap-0.5 overflow-hidden rounded-full">
        {data.timesOfDay
          .filter((t) => t.count)
          .map((t) => (
            <span key={t.key} style={{ flexGrow: t.count, background: timeFills[t.key] }} className="block" />
          ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {data.timesOfDay.map((t) => (
          <span key={t.key} className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: timeFills[t.key] }} />
            <span className="flex-1">{timeWords[t.key]}</span>
            <span className="text-on-surface-variant">{Math.round((t.count / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </>
  );
}

function PilingUp({ data }: { data: StatsData }) {
  if (data.pilingUp.length === 0) return <p className="text-on-surface-variant">Nothing's piling up.</p>;
  const max = Math.max(...data.pilingUp.map((g) => g.open));
  return (
    <ul className="flex flex-col gap-3">
      {data.pilingUp.map((g) => {
        const net = g.added - g.done;
        return (
          <li key={g.groupId ?? 'none'} className="flex items-center gap-3">
            <span className={`grid size-10 shrink-0 place-items-center rounded-2xl ${tone(g.color)}`}>
              <GroupIcon name={g.icon} className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium">{g.name}</span>
                <span className="shrink-0 text-sm text-on-surface-variant">{g.open} open</span>
              </span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-highest">
                <span className="enter-right block h-full rounded-full bg-primary" style={{ transform: `translateX(${(g.open / max) * 100 - 100}%)` }} />
              </span>
              <span className="mt-1 block text-xs text-on-surface-variant">
                {g.oldestDays > 0 ? `Oldest has waited ${plural(g.oldestDays, 'day')}` : 'All added today'}
                {net > 0 ? ` · ${net} more than a month ago` : net < 0 ? ` · ${-net} fewer than a month ago` : ''}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Tile({ value, label, detail }: { value: ReactNode; label: string; detail?: ReactNode }) {
  return (
    <div className="rounded-3xl bg-surface-high p-4">
      <p className="text-xs text-on-surface-variant">{label}</p>
      <p className="display mt-1 text-2xl leading-tight font-medium">{value}</p>
      {detail && <p className="mt-0.5 text-sm text-on-surface-variant">{detail}</p>}
    </div>
  );
}

/** How Haiku's size guesses held up: each month's guesses, and how many people kept as they were. */
function Estimates({ e }: { e: StatsData['estimates'] }) {
  const max = Math.max(1, ...e.months.map((m) => m.made));
  const changed = e.made - e.kept;
  const ratio = e.typicalRatio;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Tile value={`${Math.round((e.kept / e.made) * 100)}%`} label="Kept as guessed" detail={`${e.kept} of ${e.made} ${e.made === 1 ? 'guess' : 'guesses'}`} />
        <Tile
          value={ratio == null ? 'None yet' : ratio >= 1 ? `${ratio}× longer` : `${Math.round((1 / ratio) * 10) / 10}× shorter`}
          label="When you changed one"
          detail={changed ? `${e.raised} up, ${e.lowered} down` : 'No changes'}
        />
      </div>
      <div className="mt-4 flex h-24 items-end gap-2" aria-label="Guesses kept each month">
        {e.months.map((m, i) => (
          <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span
              className="grow-up relative w-full max-w-8 overflow-hidden rounded-lg bg-primary/25"
              style={{ height: `${m.made ? Math.max((m.made / max) * 100, 8) : 3}%`, animationDelay: `${i * 30}ms` }}
            >
              <span className="absolute inset-x-0 bottom-0 bg-primary" style={{ height: `${m.made ? (m.kept / m.made) * 100 : 0}%` }} />
            </span>
            <span className="text-xs text-on-surface-variant">{monthShort(m.month)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Records({ records }: { records: NonNullable<StatsData['records']> }) {
  const { streak, bestWeek, oldestDone, totalDone, since } = records;
  return (
    <div className="grid grid-cols-2 gap-2">
      <Tile
        label="Finished days in a row"
        value={streak.current}
        detail={streak.best > streak.current ? `Best: ${streak.best}` : streak.best > 0 ? 'Your best yet' : 'Finish a day list to start'}
      />
      <Tile label="Done so far" value={totalDone} detail={since ? `Since ${shortDate(since)}` : undefined} />
      <Tile label="Best week" value={bestWeek?.count ?? 0} detail={bestWeek ? `Week of ${shortDate(bestWeek.start)}` : undefined} />
      <Tile
        label="Waited longest"
        value={oldestDone ? plural(oldestDone.days, 'day') : '–'}
        detail={
          oldestDone ? (
            <Link to="/task/$taskId" params={{ taskId: oldestDone.taskId }} className="line-clamp-2 text-primary">
              {oldestDone.title}
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}

export function Stats() {
  const { data } = useStats();
  if (!data) {
    return (
      <>
        <PageHeader title="Stats" />
        <div className="h-40" />
      </>
    );
  }
  const colors = seriesColors(data.members);
  const thisWeek = data.weeks.at(-1)!;
  const earlier = data.weeks.slice(0, -1);
  const windowTotal = data.weeks.reduce((n, w) => n + w.total, 0);
  const usual = earlier.length ? Math.round(earlier.reduce((n, w) => n + w.total, 0) / earlier.length) : 0;
  const top = data.weekdays.reduce((a, b) => (b.count > a.count ? b : a));
  const when = data.timesOfDay.reduce((a, b) => (b.count > a.count ? b : a));

  return (
    <>
      <PageHeader eyebrow={`The last ${data.weeks.length} weeks`} title="Stats" />

      <section className="rounded-[2rem] bg-primary-container p-5 text-on-primary-container">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm">This week</h2>
          <p className="display text-2xl font-medium">{plural(thisWeek.total, 'thing')} done</p>
        </div>
        {data.members.length > 1 && (
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            {data.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <Avatar member={m} size={28} />
                <span>{firstName(m.name)}</span>
                <span className="display text-lg font-medium">{thisWeek.byMember[m.id] ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm">{windowTotal === 0 ? 'Patterns fill in here as things get done.' : `A usual week lately: about ${usual}.`}</p>
      </section>

      {windowTotal > 0 && (
        <>
          <Card title="Done each week">
            <Weekly data={data} colors={colors} />
          </Card>
          <Card title="Busiest days" footer={top.count ? `Most gets done on ${weekdayName(top.day, 'long')}s.` : undefined}>
            <Weekdays data={data} />
          </Card>
          <Card title="When things get done" footer={when.count ? `Mostly in the ${timeWords[when.key].toLowerCase()}.` : undefined}>
            <TimesOfDay data={data} />
          </Card>
        </>
      )}

      <Card title="Piling up">
        <PilingUp data={data} />
      </Card>

      {data.estimates.made > 0 && (
        <Card
          title="Almanac's size guesses"
          footer={
            data.estimates.typicalRatio == null
              ? 'Nobody has changed a guess yet. Changing one teaches Almanac your pace.'
              : data.estimates.typicalRatio > 1.15
                ? 'Things tend to take longer than Almanac guesses. Your changes teach it.'
                : data.estimates.typicalRatio < 0.87
                  ? 'Things tend to go quicker than Almanac guesses. Your changes teach it.'
                  : "When a guess is off, it's off both ways about equally."
          }
        >
          <Estimates e={data.estimates} />
        </Card>
      )}

      {data.records ? (
        <Card title="Your records">
          <Records records={data.records} />
        </Card>
      ) : (
        <p className="mt-4 px-1 text-sm text-on-surface-variant">
          Your records are hidden.{' '}
          <Link to="/settings" className="text-primary">
            Show them in Settings
          </Link>
        </p>
      )}
    </>
  );
}

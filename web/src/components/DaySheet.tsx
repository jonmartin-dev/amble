import { motion } from 'motion/react';
import Add from '~icons/material-symbols/add-rounded';
import type { Task } from '../lib/api.ts';
import { dayLabel, daysFrom, fullDate } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useEvents, useLoad, useMe, useTasks } from '../lib/queries.ts';
import { calendarLine, EventList } from './Events.tsx';
import { TaskRow } from './TaskRow.tsx';
import { LoadBar, loadWord, minutesLabel, SectionTitle, Sheet } from './ui.tsx';

const timeOrder = { morning: 0, afternoon: 1, evening: 2 } as const;

/** A day's tasks in the order the day goes: by time of day, open before done. */
export function sortDay(tasks: Task[]) {
  return [...tasks].sort(
    (a, b) =>
      (a.timeOfDay ? timeOrder[a.timeOfDay] : 3) - (b.timeOfDay ? timeOrder[b.timeOfDay] : 3) ||
      Number(a.status === 'done') - Number(b.status === 'done'),
  );
}

/** One day's plan: how full it is, what's on it, and backlog tasks to pull in. */
export function DaySheet({
  date,
  today,
  who,
  onClose,
  onMove,
}: {
  date: string | null;
  today: string;
  who: string;
  onClose: () => void;
  onMove: (task: Task) => void;
}) {
  const me = useMe();
  const actions = useTaskActions();
  const open = date != null;
  const day = date ?? today;
  const { data: load } = useLoad(day, day, open, who);
  const { data: events } = useEvents(day, day, open && who === 'me');
  const { data: planned } = useTasks({ status: 'all', who, from: day, to: day }, open);
  const { data: backlog } = useTasks({ unplanned: '1', who }, open && day >= today);
  const dayLoad = load?.[0];
  const near = Math.abs(daysFrom(today, day)) <= 1;
  const past = day < today;
  const done = planned?.filter((t) => t.status === 'done').length ?? 0;
  const total = planned?.length ?? 0;

  return (
    <Sheet open={open} onClose={onClose} label="Day plan">
      {date && (
        <>
          {near && <p className="text-sm text-on-surface-variant">{dayLabel(date, today)}</p>}
          <p className="display text-2xl leading-tight font-medium">{fullDate(date)}</p>

          {past && planned && total > 0 && (
            <div className="mt-4 rounded-3xl bg-secondary-container p-4 text-on-secondary-container">
              <div className="flex items-baseline justify-between">
                <span className="text-sm">Done</span>
                <span className="display text-xl font-medium">{done === total ? 'All of it' : `${done} of ${total}`}</span>
              </div>
              <div className="mt-2 h-3 overflow-hidden rounded-full bg-on-secondary-container/15">
                <motion.div
                  className="h-full rounded-full bg-on-secondary-container"
                  initial={false}
                  animate={{ width: `${Math.max((done / total) * 100, 2)}%` }}
                  transition={expressive.defaultSpatial}
                />
              </div>
              {done < total && (
                <p className="mt-2 text-sm">
                  {total - done} still open. Move {total - done === 1 ? 'it' : 'them'} to a day that has room, or back to the backlog.
                </p>
              )}
            </div>
          )}

          {!past && dayLoad && (
            <div className="mt-4 rounded-3xl bg-secondary-container p-4 text-on-secondary-container">
              <div className="flex items-baseline justify-between">
                <span className="text-sm">Load</span>
                <span className="display text-xl font-medium">{dayLoad.capacityMinutes === 0 && !dayLoad.tasks ? 'Day off' : loadWord(dayLoad)}</span>
              </div>
              <LoadBar load={dayLoad} className="mt-2" track="bg-on-secondary-container/15" fill="bg-on-secondary-container" />
              <p className="mt-2 text-sm">
                {dayLoad.tasks === 0
                  ? dayLoad.capacityMinutes
                    ? `Room for about ${minutesLabel(dayLoad.capacityMinutes)}.`
                    : 'No task time set aside for this day.'
                  : `${dayLoad.tasks} planned, about ${minutesLabel(dayLoad.plannedMinutes)} of ${minutesLabel(dayLoad.capacityMinutes)}.`}
                {who !== 'everyone' && calendarLine(dayLoad, who === 'me' ? 'your' : 'their') && ` ${calendarLine(dayLoad, who === 'me' ? 'your' : 'their')}`}
              </p>
            </div>
          )}

          {events && events.length > 0 && (
            <>
              <SectionTitle>On your calendar</SectionTitle>
              <EventList events={events} date={date} surface="bg-surface-high" />
            </>
          )}

          <SectionTitle>Planned</SectionTitle>
          {planned && planned.length === 0 && <p className="px-1 text-on-surface-variant">Nothing planned{past ? '.' : ' yet.'}</p>}
          <ul className="flex flex-col gap-2">
            {sortDay(planned ?? []).map((t) => (
              <li key={t.id}>
                <TaskRow task={t} today={today} meId={me?.id ?? ''} onMove={onMove} surface="bg-surface-high" />
              </li>
            ))}
          </ul>

          {!past && (
            <>
              <SectionTitle>From the backlog</SectionTitle>
              {backlog && backlog.length === 0 && <p className="px-1 text-on-surface-variant">The backlog is empty.</p>}
              <ul className="flex flex-col gap-1.5">
                {(backlog ?? []).slice(0, 8).map((t, i) => (
                  <motion.li
                    key={t.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...expressive.fastSpatial, delay: Math.min(i, 8) * 0.02 }}
                    className="flex items-center gap-3 rounded-2xl bg-surface-high py-2 pr-2 pl-4"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{t.title}</span>
                      {(t.dueDate || t.groupName) && (
                        <span className="block truncate text-xs text-on-surface-variant">
                          {t.dueDate && <span className={t.dueDate <= day ? 'text-warm' : ''}>Due {dayLabel(t.dueDate, today, true)}</span>}
                          {t.dueDate && t.groupName ? ' · ' : ''}
                          {t.groupName}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => actions.move(t, date, today)}
                      aria-label={`Plan ${t.title} for this day`}
                      className="press grid size-10 shrink-0 place-items-center rounded-full bg-primary-container text-on-primary-container"
                    >
                      <Add className="size-5" aria-hidden />
                    </button>
                  </motion.li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

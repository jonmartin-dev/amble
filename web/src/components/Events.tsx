import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import AddTask from '~icons/material-symbols/add-task-rounded';
import TaskAlt from '~icons/material-symbols/task-alt-rounded';
import type { CalendarEvent, DayLoad } from '../lib/api.ts';
import { addDays, dayLabel, isoDate, isoWeekday, timeLabel, todayIso, weekdayName } from '../lib/dates.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { minutesLabel } from './ui.tsx';

/** The events that touch a date, in this device's timezone. */
export function eventsOn(events: CalendarEvent[], date: string) {
  return events.filter((e) => {
    if (e.allDay) return e.startDate! <= date && date < e.endDate!;
    // An event ending exactly at midnight doesn't spill into the next day.
    return isoDate(new Date(e.start)) <= date && date <= isoDate(new Date(new Date(e.end).getTime() - 1));
  });
}

/** When an event is on this date: its start and, smaller, its end, like a calendar's agenda. */
function when(e: CalendarEvent, date: string): [string, string | null] {
  if (e.allDay) return ['All day', null];
  const starts = isoDate(new Date(e.start)) === date;
  const ends = isoDate(new Date(new Date(e.end).getTime() - 1)) === date;
  if (starts && ends) return [timeLabel(e.start), timeLabel(e.end)];
  if (starts) return [timeLabel(e.start), 'onward'];
  if (ends) return ['Until', timeLabel(e.end)];
  return ['All day', null];
}

// Which events this device already made a prep task for, so the button turns into a check.
const PREPPED_KEY = 'amble-prepped';
function readPrepped(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PREPPED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * A task to get ready for an event: the day before it (today, for one today or tomorrow), due the
 * day of it. Lots of things on a calendar need something done first.
 */
function usePrep() {
  const actions = useTaskActions();
  const snack = useSnackbar();
  const navigate = useNavigate();
  const [prepped, setPrepped] = useState(readPrepped);
  const key = (e: CalendarEvent, date: string) => `${e.id}:${date}`;
  const add = (e: CalendarEvent, date: string) => {
    const today = todayIso();
    const day = date > addDays(today, 1) ? addDays(date, -1) : today;
    const at = e.allDay ? weekdayName(isoWeekday(date), 'long') : `${weekdayName(isoWeekday(date), 'long')} at ${timeLabel(e.start)}`;
    const task = actions.create({ title: `Get ready for ${e.title}`, notes: `${e.title} is ${at}.`, plannedDate: day, dueDate: date });
    const next = [...prepped.slice(-200), key(e, date)];
    setPrepped(next);
    try {
      localStorage.setItem(PREPPED_KEY, JSON.stringify(next));
    } catch {
      // Private browsing: the check just won't last.
    }
    snack({
      message: `Added "${task.title}" for ${dayLabel(day, today).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}`,
      action: { label: 'Open', run: () => void navigate({ to: '/task/$taskId', params: { taskId: task.id } }) },
    });
  };
  return { add, done: (e: CalendarEvent, date: string) => prepped.includes(key(e, date)) };
}

/**
 * A day's calendar events: a colored edge per calendar, times, and titles. Free time is quieter.
 * An event still to come can get a prep task.
 */
export function EventList({ events, date, surface = 'bg-surface-low' }: { events: CalendarEvent[]; date: string; surface?: string }) {
  const prep = usePrep();
  if (events.length === 0) return null;
  const upcoming = date >= todayIso();
  return (
    <ul className="flex flex-col gap-1" aria-label="On your calendar">
      {events.map((e) => {
        const [from, to] = when(e, date);
        return (
          <li key={e.id} className={`flex items-center gap-3 overflow-hidden rounded-2xl py-2 pr-3 pl-0 ${surface} ${e.busy ? '' : 'opacity-70'}`}>
            <span className="h-8 w-1 shrink-0 rounded-r-full" style={{ background: e.color ?? 'var(--color-primary)' }} aria-hidden />
            <span className="w-[4.5rem] shrink-0 leading-tight whitespace-nowrap text-on-surface-variant tabular-nums">
              <span className="block text-sm">{from}</span>
              {to && <span className="block text-xs">{to}</span>}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {e.title ?? 'Busy'}
              {!e.busy && <span className="text-on-surface-variant"> · free</span>}
            </span>
            {upcoming &&
              e.title &&
              (prep.done(e, date) ? (
                <span className="grid size-9 shrink-0 place-items-center text-primary" title="Prep task added">
                  <TaskAlt className="size-5" aria-label="Prep task added" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => prep.add(e, date)}
                  aria-label={`Add a task to get ready for ${e.title}`}
                  title="Add a task to get ready for it"
                  className="-my-1 grid size-9 shrink-0 place-items-center rounded-full text-on-surface-variant"
                >
                  <AddTask className="size-5" aria-hidden />
                </button>
              ))}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the calendar does to a day's room, in a sentence: "2 h on your calendar, 1 h more than a
 * usual Tuesday, so there's less room for tasks." Null when there's no calendar to speak of.
 */
export function calendarLine(load: DayLoad, whose: 'your' | 'their' = 'your') {
  if (load.eventMinutes === 0 && load.usualEventMinutes === 0) return null;
  const day = weekdayName(isoWeekday(load.date), 'long');
  const diff = load.eventMinutes - load.usualEventMinutes;
  const on = load.eventMinutes ? `${minutesLabel(load.eventMinutes)} on ${whose} calendar` : `Nothing on ${whose} calendar`;
  if (Math.abs(diff) < 15) return `${on}, about usual for a ${day}.`;
  if (diff > 0) return `${on}, ${minutesLabel(diff)} more than a usual ${day}, so there's less room for tasks.`;
  return `${on}, ${minutesLabel(-diff)} less than a usual ${day}, so there's more room for tasks.`;
}

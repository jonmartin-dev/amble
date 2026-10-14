import type { CalendarEvent, DayLoad } from '../lib/api.ts';
import { isoDate, timeLabel, weekdayName, isoWeekday } from '../lib/dates.ts';
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

/** A day's calendar events: a colored edge per calendar, times, and titles. Free time is quieter. */
export function EventList({ events, date, surface = 'bg-surface-low' }: { events: CalendarEvent[]; date: string; surface?: string }) {
  if (events.length === 0) return null;
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

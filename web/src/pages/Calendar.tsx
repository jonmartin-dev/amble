import { AnimatePresence, motion, type Variants } from 'motion/react';
import { useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import ChevronLeft from '~icons/material-symbols/chevron-left-rounded';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import { DaySheet, sortDay } from '../components/DaySheet.tsx';
import { EventList, eventsOn } from '../components/Events.tsx';
import { PlanWeekSheet } from '../components/PlanWeekSheet.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { ButtonGroup, Chip, loadRatio, loadWord, minutesLabel, ScrollRow } from '../components/ui.tsx';
import type { CalendarEvent, DayLoad, DayPick, Task } from '../lib/api.ts';
import {
  addDays,
  addMonths,
  dayOfMonth,
  firstName,
  fullDate,
  isoWeekday,
  monthGrid,
  monthLabel,
  shortDate,
  startOfMonth,
  startOfWeek,
  todayIso,
  weekdayName,
  weekStartDay,
} from '../lib/dates.ts';
import { expressive, standard } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useEvents, useGaps, useLoad, useMe, useMembers, useTasks } from '../lib/queries.ts';

type View = 'week' | 'month';
const VIEW_KEY = 'almanac.calendarView';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'month' ? 'month' : 'week';
  } catch {
    return 'week';
  }
}

// Another week or month slides in from the side it's on, the one before it out the other way
// (Material's shared axis): the old one fades quickly, and the new one fades in just after, so the
// two are never both readable at once.
const slide: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
  center: { opacity: 1, x: 0, transition: { x: standard.defaultSpatial, opacity: { duration: 0.2, delay: 0.07, ease: 'easeOut' } } },
  leave: (dir: number) => ({ opacity: 0, x: dir * -32, transition: { x: standard.defaultSpatial, opacity: { duration: 0.09, ease: 'easeIn' } } }),
};

const heavy = (load?: DayLoad) => load?.level === 'full' || load?.level === 'over';

/** Seven bars, one per day, as tall as the day is full. */
function WeekBars({ dates, loads, today, onPick }: { dates: string[]; loads: Map<string, DayLoad>; today: string; onPick: (d: string) => void }) {
  return (
    <div className="flex gap-1.5 rounded-[2rem] bg-surface-low p-4">
      {dates.map((date, i) => {
        const load = loads.get(date);
        const ratio = load ? loadRatio(load) : 0;
        const isToday = date === today;
        return (
          <button
            key={date}
            type="button"
            onClick={() => onPick(date)}
            aria-label={`${fullDate(date)}: ${load ? loadWord(load) : ''}`}
            className="flex flex-1 flex-col items-center gap-2 rounded-2xl pt-1 pb-1.5 transition-colors hover:bg-surface-high"
          >
            <span className="relative flex h-28 w-full max-w-9 items-end overflow-hidden rounded-xl bg-surface-highest">
              {/* Full height, slid down so only its share shows: rises in, then glides as the day fills. */}
              <span
                className={`enter-up fill-glide absolute inset-0 rounded-xl ${heavy(load) ? 'bg-warm' : isToday ? 'bg-primary' : 'bg-primary/60'}`}
                style={{ transform: `translateY(${100 - Math.max(ratio * 100, load?.tasks ? 8 : 0)}%)`, animationDelay: `${i * 30}ms` }}
              />
            </span>
            <span className={`text-xs ${isToday ? 'font-medium text-primary' : 'text-on-surface-variant'}`}>{weekdayName(isoWeekday(date), 'narrow')}</span>
            <span
              className={`-mt-1.5 grid size-7 place-items-center rounded-full text-sm ${isToday ? 'bg-primary font-medium text-on-primary' : ''}`}
            >
              {dayOfMonth(date)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Unplanned tasks with a deadline coming up, each with the day that has the most room before it. */
function Gaps({ gaps, today }: { gaps: DayPick[]; today: string }) {
  const actions = useTaskActions();
  const [all, setAll] = useState(false);
  const shown = all ? gaps : gaps.slice(0, 3);
  return (
    <section className="mt-6 rounded-[2rem] bg-surface-low p-4">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-sm font-medium text-primary">Due soon, no day yet</h2>
        {gaps.length > 1 && (
          <button type="button" onClick={() => actions.planAll(gaps.map((g) => ({ task: g.task, date: g.date })))} className="rounded-full px-3 py-1 text-sm font-medium text-primary hover:bg-surface-high">
            Plan all {gaps.length}
          </button>
        )}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {shown.map((g) => (
            <motion.li
              key={g.task.id}
              layout
              // The rest of them, shown with "more", unfold in below.
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={expressive.defaultSpatial}
              className="flex items-center gap-3 rounded-2xl bg-surface-high py-2 pr-2 pl-4"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{g.task.title}</span>
                <span className={`block text-xs ${g.fits ? 'text-on-surface-variant' : 'text-warm'}`}>{g.reason}</span>
              </span>
              <button
                type="button"
                onClick={() => actions.move(g.task, g.date, today)}
                aria-label={`Plan ${g.task.title} for ${fullDate(g.date)}`}
                className="press h-10 shrink-0 rounded-full bg-primary-container px-4 text-sm font-medium text-on-primary-container"
              >
                {g.date === today ? 'Today' : weekdayName(isoWeekday(g.date))}
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {gaps.length > 3 && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 px-1 text-sm font-medium text-primary">
          {gaps.length - 3} more
        </button>
      )}
    </section>
  );
}

function WeekList({
  dates,
  loads,
  byDay,
  events,
  today,
  meId,
  onOpen,
  onMove,
}: {
  dates: string[];
  loads: Map<string, DayLoad>;
  byDay: Map<string, Task[]>;
  events: CalendarEvent[];
  today: string;
  meId: string;
  onOpen: (d: string) => void;
  onMove: (t: Task) => void;
}) {
  return (
    <>
      {dates.map((date) => {
        const load = loads.get(date);
        const tasks = byDay.get(date) ?? [];
        const dayEvents = eventsOn(events, date);
        const isToday = date === today;
        const done = tasks.filter((t) => t.status === 'done').length;
        // Past days say what got done; today and later say how full they are.
        const summary =
          date < today
            ? tasks.length
              ? `${done} done${done < tasks.length ? ` · ${tasks.length - done} left` : ''}`
              : null
            : load && `${loadWord(load)}${load.tasks ? ` · ${minutesLabel(load.plannedMinutes)}` : ''}`;
        return (
          <section key={date} className="mt-6">
            <button type="button" onClick={() => onOpen(date)} className="flex w-full items-baseline justify-between gap-3 px-1 text-left">
              <span>
                <span className={`font-medium ${isToday ? 'text-primary' : ''}`}>{isToday ? 'Today' : weekdayName(isoWeekday(date), 'long')}</span>
                <span className="text-on-surface-variant"> · {shortDate(date)}</span>
              </span>
              {summary && (
                <span className={`shrink-0 text-sm ${date >= today && heavy(load) ? 'text-warm' : 'text-on-surface-variant'}`}>{summary}</span>
              )}
            </button>
            {dayEvents.length > 0 && (
              <div className="mt-2">
                <EventList events={dayEvents} date={date} />
              </div>
            )}
            {tasks.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-2">
                <AnimatePresence initial={false}>
                  {tasks.map((t) => (
                    <motion.li key={t.id} layout exit={{ opacity: 0, height: 0 }} transition={expressive.defaultSpatial}>
                      <TaskRow task={t} today={today} meId={meId} onMove={onMove} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            ) : date < today ? (
              dayEvents.length === 0 && <p className="mt-1 px-1 text-sm text-on-surface-variant">Nothing was planned.</p>
            ) : (
              <button
                type="button"
                onClick={() => onOpen(date)}
                className="mt-2 w-full rounded-3xl border border-dashed border-outline-variant px-4 py-3 text-left text-sm text-on-surface-variant"
              >
                Nothing planned. Pull something in from the backlog
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}

function MonthGrid({
  anchor,
  dates,
  loads,
  byDay,
  today,
  onOpen,
}: {
  anchor: string;
  dates: string[];
  loads: Map<string, DayLoad>;
  byDay: Map<string, Task[]>;
  today: string;
  onOpen: (d: string) => void;
}) {
  const month = anchor.slice(0, 7);
  return (
    <div className="rounded-[2rem] bg-surface-low p-2">
      <div className="mb-1 grid grid-cols-7 text-center text-xs text-on-surface-variant">
        {dates.slice(0, 7).map((d) => (
          <span key={d} className="py-1.5">
            {weekdayName(isoWeekday(d), 'narrow')}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {dates.map((date) => {
          const load = loads.get(date);
          const tasks = byDay.get(date) ?? [];
          const open = tasks.filter((t) => t.status === 'open').length;
          const done = tasks.length - open;
          const isToday = date === today;
          const past = date < today;
          const inMonth = date.slice(0, 7) === month;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onOpen(date)}
              aria-label={`${fullDate(date)}${past ? (done ? `, ${done} done` : '') : load ? `, ${loadWord(load)}` : ''}${open ? `, ${open} open` : ''}`}
              className={`flex aspect-[4/5] flex-col items-center rounded-2xl pt-1 pb-2 transition-colors hover:bg-surface-high ${inMonth ? '' : 'opacity-35'}`}
            >
              <span className={`grid size-8 place-items-center rounded-full text-sm ${isToday ? 'bg-primary font-medium text-on-primary' : date < today ? 'text-on-surface-variant' : ''}`}>
                {dayOfMonth(date)}
              </span>
              {past ? (
                <span className="mt-auto flex items-center text-[0.6875rem] leading-none text-primary">
                  {done > 0 && (
                    <>
                      <Check className="size-3" aria-hidden />
                      {done}
                    </>
                  )}
                </span>
              ) : (
                <span className="mt-auto text-[0.6875rem] leading-none text-on-surface-variant">{open || ''}</span>
              )}
              <span className={`mt-1 h-1.5 w-[70%] overflow-hidden rounded-full ${past ? '' : 'bg-surface-highest'}`}>
                {!past && load && load.tasks > 0 && (
                  <span
                    className={`block h-full rounded-full ${heavy(load) ? 'bg-warm' : 'bg-primary'}`}
                    style={{ width: `${Math.max(loadRatio(load) * 100, 12)}%` }}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Calendar() {
  const me = useMe();
  const { data: household } = useMembers();
  const others = household?.members.filter((m) => m.id !== me?.id) ?? [];
  const today = todayIso();
  const weekStart = weekStartDay();
  const [view, setView] = useState<View>(savedView);
  const [who, setWho] = useState('me');
  const [anchor, setAnchor] = useState(today);
  // Which way the last move went: 1 later, -1 earlier, 0 a change of view.
  const [dir, setDir] = useState(0);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<Task | null>(null);
  const [planning, setPlanning] = useState(false);

  const dates =
    view === 'week'
      ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, weekStart), i))
      : monthGrid(anchor, weekStart);
  const start = dates[0]!;
  const end = dates.at(-1)!;
  const { data: loadDays } = useLoad(start, end, true, who);
  const { data: tasks } = useTasks({ status: 'all', who, from: start, to: end });
  const { data: events } = useEvents(start, end, who === 'me');
  const { data: gaps } = useGaps(who === 'me');
  const loads = new Map((loadDays ?? []).map((d) => [d.date, d]));
  const byDay = new Map<string, Task[]>();
  for (const t of sortDay(tasks ?? [])) byDay.set(t.plannedDate!, [...(byDay.get(t.plannedDate!) ?? []), t]);

  const switchView = (v: View) => {
    setDir(0);
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembering the choice is fine.
    }
  };
  const step = (n: number) => {
    setDir(n);
    setAnchor((a) => (view === 'week' ? addDays(a, 7 * n) : addMonths(a, n)));
  };
  const showingToday = view === 'week' ? dates.includes(today) : startOfMonth(anchor) === startOfMonth(today);
  const title = view === 'week' ? `${shortDate(start)} – ${shortDate(end)}` : monthLabel(anchor);
  const weekTotal = dates.reduce((n, d) => n + (loads.get(d)?.plannedMinutes ?? 0), 0);

  return (
    <>
      <PageHeader eyebrow={title} title="Calendar" />

      {others.length > 0 && (
        <ScrollRow className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4" aria-label="Whose calendar">
          <Chip selected={who === 'me'} onClick={() => setWho('me')}>
            Mine
          </Chip>
          {others.map((o) => (
            <Chip key={o.id} selected={who === o.id} onClick={() => setWho(o.id)}>
              {firstName(o.name)}
            </Chip>
          ))}
          <Chip selected={who === 'everyone'} onClick={() => setWho('everyone')}>
            Everyone
          </Chip>
        </ScrollRow>
      )}

      {who === 'me' && (
        <button
          type="button"
          onClick={() => setPlanning(true)}
          className="press mb-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-secondary-container font-medium text-on-secondary-container"
        >
          <Sparkle className="size-5" aria-hidden />
          Plan my week
        </button>
      )}

      <div className="mb-4 flex items-center gap-2">
        <div className="w-44">
          <ButtonGroup<View>
            label="Calendar view"
            size="sm"
            value={view}
            onChange={switchView}
            options={[
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
            ]}
          />
        </div>
        <span className="flex-1" />
        {!showingToday && (
          <button
            type="button"
            onClick={() => {
              setDir(anchor < today ? 1 : -1);
              setAnchor(today);
            }}
            className="rounded-full px-3 py-2 text-sm font-medium text-primary hover:bg-surface-high"
          >
            Today
          </button>
        )}
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
          className="grid size-10 place-items-center rounded-full bg-surface-high"
        >
          <ChevronLeft className="size-6" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label={view === 'week' ? 'Next week' : 'Next month'}
          className="grid size-10 place-items-center rounded-full bg-surface-high"
        >
          <ChevronRight className="size-6" aria-hidden />
        </button>
      </div>

      <div className="relative">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div key={`${view} ${start}`} custom={dir} variants={slide} initial="enter" animate="center" exit="leave">
            {view === 'week' ? (
              <>
                <WeekBars dates={dates} loads={loads} today={today} onPick={setOpenDay} />
                <p className="mt-2 px-1 text-sm text-on-surface-variant">
                  {weekTotal ? `About ${minutesLabel(weekTotal)} planned this week.` : 'Nothing planned this week yet.'} Tap a day to plan it.
                </p>
                {who === 'me' && gaps && gaps.length > 0 && dates.at(-1)! >= today && <Gaps gaps={gaps} today={today} />}
                <WeekList dates={dates} loads={loads} byDay={byDay} events={events ?? []} today={today} meId={me?.id ?? ''} onOpen={setOpenDay} onMove={setMoving} />
              </>
            ) : (
              <>
                <MonthGrid anchor={anchor} dates={dates} loads={loads} byDay={byDay} today={today} onOpen={setOpenDay} />
                <p className="mt-2 px-1 text-sm text-on-surface-variant">
                  Bars show how full each day is, and amber means heavy. Numbers are open tasks, and ticks count what got done. Tap a day to see or change its plan.
                </p>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <DaySheet date={openDay} today={today} who={who} onClose={() => setOpenDay(null)} onMove={setMoving} />
      <MoveSheet task={moving} today={today} onClose={() => setMoving(null)} />
      <PlanWeekSheet open={planning} onClose={() => setPlanning(false)} today={today} />
    </>
  );
}

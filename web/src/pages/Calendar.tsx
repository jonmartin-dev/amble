import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import ChevronLeft from '~icons/material-symbols/chevron-left-rounded';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import { DaySheet, sortDay } from '../components/DaySheet.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { ButtonGroup, Chip, loadRatio, loadWord, minutesLabel } from '../components/ui.tsx';
import type { DayLoad, Task } from '../lib/api.ts';
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
import { expressive } from '../lib/motion.ts';
import { useLoad, useMe, useMembers, useTasks } from '../lib/queries.ts';

type View = 'week' | 'month';
const VIEW_KEY = 'almanac.calendarView';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'month' ? 'month' : 'week';
  } catch {
    return 'week';
  }
}

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
              <motion.span
                className={`w-full rounded-xl ${heavy(load) ? 'bg-warm' : isToday ? 'bg-primary' : 'bg-primary/60'}`}
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(ratio * 100, load?.tasks ? 8 : 0)}%` }}
                transition={{ ...expressive.defaultSpatial, delay: i * 0.03 }}
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

function WeekList({
  dates,
  loads,
  byDay,
  today,
  meId,
  onOpen,
  onMove,
}: {
  dates: string[];
  loads: Map<string, DayLoad>;
  byDay: Map<string, Task[]>;
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
              <p className="mt-1 px-1 text-sm text-on-surface-variant">Nothing was planned.</p>
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
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [moving, setMoving] = useState<Task | null>(null);

  const dates =
    view === 'week'
      ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, weekStart), i))
      : monthGrid(anchor, weekStart);
  const start = dates[0]!;
  const end = dates.at(-1)!;
  const { data: loadDays } = useLoad(start, end, true, who);
  const { data: tasks } = useTasks({ status: 'all', who, from: start, to: end });
  const loads = new Map((loadDays ?? []).map((d) => [d.date, d]));
  const byDay = new Map<string, Task[]>();
  for (const t of sortDay(tasks ?? [])) byDay.set(t.plannedDate!, [...(byDay.get(t.plannedDate!) ?? []), t]);

  const switchView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembering the choice is fine.
    }
  };
  const step = (n: number) => setAnchor((a) => (view === 'week' ? addDays(a, 7 * n) : addMonths(a, n)));
  const showingToday = view === 'week' ? dates.includes(today) : startOfMonth(anchor) === startOfMonth(today);
  const title = view === 'week' ? `${shortDate(start)} – ${shortDate(end)}` : monthLabel(anchor);
  const weekTotal = dates.reduce((n, d) => n + (loads.get(d)?.plannedMinutes ?? 0), 0);

  return (
    <>
      <PageHeader eyebrow={title} title="Calendar" />

      {others.length > 0 && (
        <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4" aria-label="Whose calendar">
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
        </div>
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
          <button type="button" onClick={() => setAnchor(today)} className="rounded-full px-3 py-2 text-sm font-medium text-primary hover:bg-surface-high">
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

      {view === 'week' ? (
        <>
          <WeekBars dates={dates} loads={loads} today={today} onPick={setOpenDay} />
          <p className="mt-2 px-1 text-sm text-on-surface-variant">
            {weekTotal ? `About ${minutesLabel(weekTotal)} planned this week.` : 'Nothing planned this week yet.'} Tap a day to plan it.
          </p>
          <WeekList dates={dates} loads={loads} byDay={byDay} today={today} meId={me?.id ?? ''} onOpen={setOpenDay} onMove={setMoving} />
        </>
      ) : (
        <>
          <MonthGrid anchor={anchor} dates={dates} loads={loads} byDay={byDay} today={today} onOpen={setOpenDay} />
          <p className="mt-2 px-1 text-sm text-on-surface-variant">
            Bars show how full each day is, and amber means heavy. Numbers are open tasks, and ticks count what got done. Tap a day to see or change its plan.
          </p>
        </>
      )}

      <DaySheet date={openDay} today={today} who={who} onClose={() => setOpenDay(null)} onMove={setMoving} />
      <MoveSheet task={moving} today={today} onClose={() => setMoving(null)} />
    </>
  );
}

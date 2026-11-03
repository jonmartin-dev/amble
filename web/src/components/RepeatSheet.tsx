// Sets how a task repeats: on a calendar schedule, or a set time after the last one was done.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import Minus from '~icons/material-symbols/remove-rounded';
import Plus from '~icons/material-symbols/add-rounded';
import { describeRepeat, MONTHS, monthName, ordinal, repeatOn, type Repeat, type RepeatUnit } from '../../../shared/repeat.ts';
import { isoWeekday, weekdayName, weekStartDay } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { ButtonGroup, Chip, ScrollRow, Sheet, Switch } from './ui.tsx';

const UNITS: { value: RepeatUnit; one: string; many: string }[] = [
  { value: 'day', one: 'Day', many: 'Days' },
  { value: 'week', one: 'Week', many: 'Weeks' },
  { value: 'month', one: 'Month', many: 'Months' },
  { value: 'year', one: 'Year', many: 'Years' },
];

/**
 * A part that comes and goes with the choices above it, opening out and folding away rather than
 * popping. It's only built while it shows, since what's in it can need what it shows for.
 */
function Reveal({ show, children }: { show: boolean; children: () => ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={expressive.defaultSpatial} className="overflow-hidden">
          {children()}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Label({ children }: { children: string }) {
  return <p className="mt-5 mb-2 px-1 text-sm font-medium text-primary">{children}</p>;
}

export function RepeatSheet({
  open,
  onClose,
  value,
  date,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  value: Repeat | null;
  /** The task's current date (planned, or due for "after" ones), which fills in the defaults. */
  date: string;
  onSave: (r: Repeat | null) => void;
}) {
  const fresh: Repeat = { mode: 'schedule', every: 1, unit: 'week', weekdays: [isoWeekday(date)] };
  const [r, setR] = useState<Repeat>(value ?? fresh);
  useEffect(() => {
    if (open) setR(value ?? fresh);
  }, [open]);
  const set = (patch: Partial<Repeat>) => setR((cur) => ({ ...cur, ...patch }));
  const d = new Date(`${date}T12:00:00`);
  const dow = isoWeekday(date);
  const nth = Math.ceil(d.getDate() / 7);
  const lastWeek = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const weekOrder = Array.from({ length: 7 }, (_, i) => ((weekStartDay() - 1 + i) % 7) + 1);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label="Repeats"
      header={<p className="pb-1 text-lg font-medium">Repeats</p>}
      footer={
        <div className="flex gap-2">
          {value && (
            <button
              type="button"
              onClick={() => {
                onSave(null);
                onClose();
              }}
              className="h-12 flex-1 rounded-full bg-surface-high font-medium"
            >
              Stop repeating
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onSave(r);
              onClose();
            }}
            className="h-12 flex-1 rounded-full bg-primary font-medium text-on-primary"
          >
            Save
          </button>
        </div>
      }
    >
      <ButtonGroup
        label="Kind of repeat"
        value={r.mode}
        onChange={(mode) => set({ mode, on: null })}
        options={[
          { value: 'schedule', label: 'On a schedule' },
          { value: 'after', label: "After it's done" },
        ]}
      />
      <p className="mt-2 px-1 text-sm text-on-surface-variant">
        {r.mode === 'schedule' ? 'Comes back on set days, like every Sunday or the 1st.' : 'Comes back a set time after the last one was finished, like a filter change.'}
      </p>

      <Label>Every</Label>
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-full bg-surface-high">
          <button type="button" aria-label="Fewer" onClick={() => set({ every: Math.max(1, r.every - 1) })} className="grid size-11 place-items-center rounded-full">
            <Minus className="size-5" aria-hidden />
          </button>
          <span className="w-8 text-center text-lg font-medium tabular-nums">{r.every}</span>
          <button type="button" aria-label="More" onClick={() => set({ every: Math.min(365, r.every + 1) })} className="grid size-11 place-items-center rounded-full">
            <Plus className="size-5" aria-hidden />
          </button>
        </div>
        <ScrollRow className="-mr-5 -my-2 flex gap-2 overflow-x-auto py-2 pr-5">
          {UNITS.filter((u) => r.mode === 'schedule' || u.value !== 'year').map((u) => (
            <Chip
              key={u.value}
              selected={r.unit === u.value}
              onClick={() =>
                set({
                  unit: u.value,
                  weekdays: u.value === 'week' ? (r.weekdays?.length ? r.weekdays : [dow]) : null,
                  day: u.value === 'month' || u.value === 'year' ? d.getDate() : null,
                  month: u.value === 'year' ? d.getMonth() + 1 : null,
                  nth: null,
                  weekday: null,
                })
              }
            >
              {r.every === 1 ? u.one : u.many}
            </Chip>
          ))}
        </ScrollRow>
      </div>

      <Reveal show={r.mode === 'schedule' && r.unit === 'week'}>
        {() => (
          <>
            <Label>On</Label>
            <div className="flex justify-between gap-1">
              {weekOrder.map((day) => {
                const on = r.weekdays?.includes(day) ?? false;
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={weekdayName(day, 'long')}
                    onClick={() => {
                      const next = on ? (r.weekdays ?? []).filter((x) => x !== day) : [...(r.weekdays ?? []), day];
                      if (next.length) set({ weekdays: next.sort((a, b) => a - b) });
                    }}
                    className={`grid aspect-square flex-1 place-items-center rounded-full text-sm font-medium transition-colors ${
                      on ? 'bg-primary text-on-primary' : 'bg-surface-high text-on-surface'
                    }`}
                  >
                    {weekdayName(day, 'narrow')}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Reveal>

      <Reveal show={r.mode === 'schedule' && r.unit === 'month'}>
        {() => (
          <>
            <Label>On</Label>
            <div className="flex flex-wrap gap-2">
              <Chip selected={!r.nth && r.day !== -1} onClick={() => set({ day: d.getDate(), nth: null, weekday: null })}>
                The {ordinal(d.getDate())}
              </Chip>
              {nth <= 4 && (
                <Chip selected={r.nth === nth && r.weekday === dow} onClick={() => set({ nth, weekday: dow, day: null })}>
                  The {ordinal(nth)} {weekdayName(dow, 'long')}
                </Chip>
              )}
              {lastWeek && (
                <Chip selected={r.nth === -1 && r.weekday === dow} onClick={() => set({ nth: -1, weekday: dow, day: null })}>
                  The last {weekdayName(dow, 'long')}
                </Chip>
              )}
              <Chip selected={r.day === -1} onClick={() => set({ day: -1, nth: null, weekday: null })}>
                The last day
              </Chip>
            </div>
            <p className="mt-2 px-1 text-xs text-on-surface-variant">These follow the task's date. Change its day to pick another.</p>
          </>
        )}
      </Reveal>

      <div className="mt-5 flex items-center justify-between gap-3 px-1">
        <div>
          <p className="font-medium">Only in some months</p>
          <p className="text-sm text-on-surface-variant">For seasonal things, like mowing</p>
        </div>
        <Switch
          label="Only in some months"
          checked={!!r.months?.length}
          onChange={(v) => set({ months: v ? [4, 5, 6, 7, 8, 9, 10] : null })}
        />
      </div>
      <Reveal show={!!r.months?.length}>
        {() => (
          <div className="mt-3 grid grid-cols-6 gap-1.5">
            {MONTHS.map((m) => {
              const on = r.months!.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? r.months!.filter((x) => x !== m) : [...r.months!, m].sort((a, b) => a - b);
                    if (next.length) set({ months: next });
                  }}
                  className={`h-10 rounded-xl text-sm font-medium transition-colors ${on ? 'bg-primary text-on-primary' : 'bg-surface-high'}`}
                >
                  {monthName(m, 'short')}
                </button>
              );
            })}
          </div>
        )}
      </Reveal>

      <div className="mt-5 flex items-center justify-between gap-3 px-1">
        <div>
          <p className="font-medium">Due by the date</p>
          <p className="text-sm text-on-surface-variant">Off: each one goes on that day's list</p>
        </div>
        <Switch label="Due by the date" checked={repeatOn(r) === 'due'} onChange={(v) => set({ on: v ? 'due' : 'planned' })} />
      </div>

      <p className="mt-5 mb-2 rounded-2xl bg-secondary-container px-4 py-3 text-on-secondary-container">{describeRepeat(r, date)}</p>
    </Sheet>
  );
}

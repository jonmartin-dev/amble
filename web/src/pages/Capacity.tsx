import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import Remove from '~icons/material-symbols/remove-rounded';
import { minutesLabel, segment, SubpageHeader } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { weekdayName, weekStartDay } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { useMe } from '../lib/queries.ts';

const STEP = 30;
const MAX = 720;
const defaultFor = (day: number) => (day >= 6 ? 240 : 180);

/** How much task time fits in each weekday, for this person. */
export function Capacity() {
  const me = useMe();
  const qc = useQueryClient();
  const snack = useSnackbar();
  const days = Array.from({ length: 7 }, (_, i) => ((weekStartDay() - 1 + i) % 7) + 1);
  const [minutes, setMinutes] = useState<Record<number, number>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!me) return;
    setMinutes(Object.fromEntries(days.map((d) => [d, me.capacity?.[String(d)] ?? defaultFor(d)])));
    // Only when the account loads; after that this page owns the numbers.
  }, [me?.id]);

  const save = (next: Record<number, number>) => {
    clearTimeout(timer.current);
    // Wait for a pause in tapping, then save only the days that differ from the default.
    timer.current = setTimeout(() => {
      const custom = Object.fromEntries(days.filter((d) => next[d] !== defaultFor(d)).map((d) => [String(d), next[d]]));
      void api('/me', { method: 'PATCH', body: JSON.stringify({ capacity: Object.keys(custom).length ? custom : null }) }).then(
        () => {
          for (const key of ['session', 'load', 'today']) void qc.invalidateQueries({ queryKey: [key] });
        },
        (e: Error) => snack({ message: e.message }),
      );
    }, 500);
  };

  const change = (day: number, by: number) => {
    const next = { ...minutes, [day]: Math.min(MAX, Math.max(0, (minutes[day] ?? defaultFor(day)) + by)) };
    setMinutes(next);
    save(next);
  };
  const reset = () => {
    const next = Object.fromEntries(days.map((d) => [d, defaultFor(d)]));
    setMinutes(next);
    save(next);
  };
  const custom = days.some((d) => minutes[d] !== undefined && minutes[d] !== defaultFor(d));

  return (
    <>
      <SubpageHeader title="Daily capacity" />
      <p className="px-1 text-on-surface-variant">
        How much time you have for tasks each day, outside work and plans. Almanac measures how full a day is against this, and so does Claude.
      </p>

      <ul className="mt-5 flex flex-col gap-0.5">
        {days.map((d, i) => {
          const value = minutes[d] ?? defaultFor(d);
          const name = weekdayName(d, 'long');
          return (
            <li key={d} className={`flex items-center gap-3 bg-surface-low py-2.5 pr-2.5 pl-4 ${segment(i, days.length)}`}>
              <span className="min-w-0 flex-1">
                <span className="block">{name}</span>
                <span className="mt-1.5 block h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-surface-highest">
                  <motion.span
                    className="block h-full rounded-full bg-primary"
                    initial={false}
                    animate={{ width: `${(value / 480) * 100}%` }}
                    transition={expressive.fastSpatial}
                  />
                </span>
              </span>
              <span className="display w-20 text-center text-lg font-medium" aria-live="polite">
                {value ? minutesLabel(value) : 'Day off'}
              </span>
              <button
                type="button"
                onClick={() => change(d, -STEP)}
                disabled={value <= 0}
                aria-label={`Less time on ${name}`}
                className="grid size-10 place-items-center rounded-full bg-surface-high disabled:opacity-40"
              >
                <Remove className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => change(d, STEP)}
                disabled={value >= MAX}
                aria-label={`More time on ${name}`}
                className="grid size-10 place-items-center rounded-full bg-surface-high disabled:opacity-40"
              >
                <Add className="size-5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      {custom && (
        <button type="button" onClick={reset} className="mt-4 rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high">
          Back to the defaults
        </button>
      )}
      <p className="mt-4 px-1 text-sm text-on-surface-variant">
        The defaults are {minutesLabel(180)} on weekdays and {minutesLabel(240)} on weekends. Later, Almanac will learn this from what actually gets done.
      </p>
    </>
  );
}

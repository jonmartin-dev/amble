import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import PushPin from '~icons/material-symbols/keep-rounded';
import Remove from '~icons/material-symbols/remove-rounded';
import { minutesLabel, segment, SubpageHeader } from '../components/ui.tsx';
import { type CapacityDay } from '../lib/api.ts';
import { weekdayName, weekStartDay } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useSaveMe } from '../lib/mutations.ts';
import { useCapacity, useMe } from '../lib/queries.ts';

const STEP = 30;
const MAX = 720;

function learnedNote(day: CapacityDay) {
  if (day.samples === 0) return 'Starting point until Almanac has seen a few of these';
  if (day.confidence < 1) return `Still learning, from ${day.samples} ${day.samples === 1 ? 'day' : 'days'} so far`;
  return `Learned from your recent ${weekdayName(day.weekday, 'long')}s`;
}

/** How much task time fits in each weekday: learned from what gets done, with optional pins. */
export function Capacity() {
  const me = useMe();
  const { data: learned } = useCapacity();
  const saveMe = useSaveMe();
  const days = Array.from({ length: 7 }, (_, i) => ((weekStartDay() - 1 + i) % 7) + 1);
  const [pins, setPins] = useState<Record<number, number | undefined>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!me) return;
    setPins(Object.fromEntries(Object.entries(me.capacity ?? {}).map(([d, m]) => [Number(d), m])));
    // Only when the account loads; after that this page owns the pins.
  }, [me?.id]);

  const save = (next: Record<number, number | undefined>) => {
    clearTimeout(timer.current);
    // Wait for a pause in tapping, then save the pinned days.
    timer.current = setTimeout(() => {
      const pinned = Object.fromEntries(Object.entries(next).filter(([, m]) => m !== undefined));
      saveMe({ capacity: Object.keys(pinned).length ? pinned : null }, 'Change your capacity');
    }, 500);
  };

  const learnedFor = (d: number) => learned?.find((x) => x.weekday === d);
  const update = (next: Record<number, number | undefined>) => {
    setPins(next);
    save(next);
  };
  const change = (d: number, by: number) => {
    const current = pins[d] ?? learnedFor(d)?.minutes ?? 180;
    update({ ...pins, [d]: Math.min(MAX, Math.max(0, current + by)) });
  };
  const anyPinned = days.some((d) => pins[d] !== undefined);

  return (
    <>
      <SubpageHeader title="Daily capacity" />
      <p className="px-1 text-on-surface-variant">
        How much time you have for tasks each day. Almanac learns it from what you actually finish, so there's nothing to set up. If a day is different
        (a day off, a long shift), pin your own number with the buttons.
      </p>

      <ul className="mt-5 flex flex-col gap-0.5">
        {days.map((d, i) => {
          const day = learnedFor(d);
          const pinned = pins[d];
          const value = pinned ?? day?.minutes ?? 0;
          const name = weekdayName(d, 'long');
          return (
            <li key={d} className={`flex items-center gap-2 bg-surface-low py-2.5 pr-2.5 pl-4 ${segment(i, days.length)}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  {name}
                  {pinned !== undefined && <PushPin className="size-4 text-primary" aria-label="Pinned" />}
                </span>
                <span className="mt-0.5 block text-xs text-on-surface-variant">{pinned !== undefined ? 'Pinned by you' : day ? learnedNote(day) : ' '}</span>
                <span className="mt-1.5 block h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-surface-highest">
                  <motion.span
                    className={`block h-full rounded-full ${pinned !== undefined ? 'bg-primary' : 'bg-secondary'}`}
                    initial={false}
                    animate={{ width: `${Math.min(value / 480, 1) * 100}%` }}
                    transition={expressive.fastSpatial}
                  />
                </span>
              </span>
              <span className="display w-18 shrink-0 text-center text-lg font-medium" aria-live="polite">
                {day || pinned !== undefined ? (value ? minutesLabel(value) : 'Day off') : ''}
              </span>
              <button
                type="button"
                onClick={() => change(d, -STEP)}
                disabled={value <= 0}
                aria-label={`Less time on ${name}`}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-high disabled:opacity-40"
              >
                <Remove className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => change(d, STEP)}
                disabled={value >= MAX}
                aria-label={`More time on ${name}`}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-high disabled:opacity-40"
              >
                <Add className="size-5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      {anyPinned && (
        <div className="mt-4 flex flex-wrap gap-2">
          {days
            .filter((d) => pins[d] !== undefined)
            .map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => update({ ...pins, [d]: undefined })}
                className="rounded-full bg-surface-high px-4 py-2 text-sm font-medium"
              >
                Let Almanac learn {weekdayName(d, 'long')}
              </button>
            ))}
        </div>
      )}
      <p className="mt-4 px-1 text-sm text-on-surface-variant">
        It starts at {minutesLabel(180)} on weekdays and {minutesLabel(240)} on weekends and moves toward a good day's worth of what you finish,
        counting tasks without an estimate as half an hour. It won't learn a day below half its starting point; pin a lower number (or 0 for a day off) if that's what you want. Days you don't open Almanac don't count against you.
      </p>
    </>
  );
}

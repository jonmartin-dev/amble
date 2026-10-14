import { motion } from 'motion/react';
import Inbox from '~icons/material-symbols/inbox-outline-rounded';
import Today from '~icons/material-symbols/today-outline-rounded';
import type { Task } from '../lib/api.ts';
import { addDays, dayLabel, dayOfMonth, weekdayShort } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useLoad } from '../lib/queries.ts';
import { LoadBar, loadWord, Sheet } from './ui.tsx';

/** Pick a day for a task, seeing how full each of the next two weeks already is. */
export function MoveSheet({ task, today, onClose }: { task: Task | null; today: string; onClose: () => void }) {
  const actions = useTaskActions();
  const end = addDays(today, 13);
  const { data: days } = useLoad(today, end, task != null);

  const pick = (date: string | null) => {
    if (task) actions.move(task, date, today);
    onClose();
  };

  return (
    <Sheet open={task != null} onClose={onClose} label="Move task">
      {task && (
        <>
          <p className="text-sm text-on-surface-variant">Move</p>
          <p className="display mt-0.5 text-2xl leading-tight font-medium">{task.title}</p>
          {task.dueDate && <p className="mt-1 text-sm text-warm">Due {dayLabel(task.dueDate, today, true)}</p>}

          <ul className="mt-5 flex flex-col gap-1.5">
            {(days ?? []).map((d, i) => {
              const current = task.plannedDate === d.date;
              const pastDue = task.dueDate != null && d.date > task.dueDate;
              return (
                <motion.li
                  key={d.date}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...expressive.fastSpatial, delay: Math.min(i, 8) * 0.02 }}
                >
                  <button
                    type="button"
                    onClick={() => pick(d.date)}
                    className={`flex w-full items-center gap-4 rounded-2xl px-3 py-2.5 text-left transition-colors ${
                      current ? 'bg-secondary-container text-on-secondary-container' : 'hover:bg-surface-high'
                    } ${pastDue ? 'opacity-55' : ''}`}
                  >
                    <span className="w-11 text-center">
                      <span className="block text-xs text-on-surface-variant">{weekdayShort(d.date)}</span>
                      <span className="display block text-xl leading-none font-medium">{dayOfMonth(d.date)}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between text-sm">
                        <span className="font-medium">{i < 2 ? dayLabel(d.date, today) : ''}</span>
                        <span className="text-on-surface-variant">
                          {loadWord(d)}
                          {d.tasks ? ` · ${d.tasks}` : ''}
                        </span>
                      </span>
                      <LoadBar load={d} className="mt-1.5 h-2" track="bg-surface-highest" />
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ul>

          <div className="mt-4 flex gap-2">
            <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-surface-high py-3 text-sm font-medium">
              <Today className="size-5" aria-hidden />
              Another day
              <input
                type="date"
                min={today}
                className="sr-only"
                onChange={(e) => e.target.value && pick(e.target.value)}
                onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
              />
            </label>
            <button
              type="button"
              onClick={() => pick(null)}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-surface-high py-3 text-sm font-medium"
            >
              <Inbox className="size-5" aria-hidden />
              Backlog
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

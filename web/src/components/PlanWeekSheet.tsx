import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import { api, type PlannedWeek } from '../lib/api.ts';
import { dayLabel, dayOfMonth, weekdayShort } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useAi } from '../lib/queries.ts';
import { useSyncState } from '../lib/sync.ts';
import { Checkbox, LoadBar, loadWord, minutesLabel, Sheet } from './ui.tsx';

/**
 * Plan my week: say anything to keep in mind, get a plan that puts backlog tasks on the days with
 * room, untick what you don't want, and plan the rest in one go.
 */
export function PlanWeekSheet({ open, onClose, today }: { open: boolean; onClose: () => void; today: string }) {
  const actions = useTaskActions();
  const { data: ai } = useAi();
  const { online } = useSyncState();
  const [note, setNote] = useState('');
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const plan = useMutation({
    mutationFn: (note: string) => api<PlannedWeek>('/plan-week', { method: 'POST', body: JSON.stringify(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => setSkipped(new Set()),
  });

  useEffect(() => {
    if (!open) {
      plan.reset();
      setNote('');
    }
    // Only when the sheet opens or closes.
  }, [open]);

  // Without Haiku there's nothing to say to it, so go straight to the plan.
  useEffect(() => {
    if (open && ai && !ai.available && online && plan.isIdle) plan.mutate('');
  }, [open, ai, online, plan]);

  const week = plan.data;
  const chosen = week?.picks.filter((p) => !skipped.has(p.task.id)) ?? [];
  const toggle = (id: string) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const apply = () => {
    actions.planAll(chosen.map((p) => ({ task: p.task, date: p.date })));
    onClose();
  };

  const footer = week ? (
    <div className="flex gap-2">
      <button type="button" onClick={() => plan.reset()} className="h-12 rounded-full px-5 font-medium text-primary hover:bg-surface-high">
        Start over
      </button>
      <button
        type="button"
        onClick={apply}
        disabled={chosen.length === 0}
        className="h-12 flex-1 rounded-full bg-primary font-medium text-on-primary transition-opacity disabled:opacity-40"
      >
        {chosen.length ? `Plan ${chosen.length} ${chosen.length === 1 ? 'task' : 'tasks'}` : 'Nothing to plan'}
      </button>
    </div>
  ) : ai?.available ? (
    <button
      type="button"
      onClick={() => plan.mutate(note)}
      disabled={plan.isPending || !online}
      className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary font-medium text-on-primary transition-opacity disabled:opacity-50"
    >
      <Sparkle className="size-5" aria-hidden />
      {plan.isPending ? 'Planning…' : online ? 'Make a plan' : 'Planning needs a connection'}
    </button>
  ) : null;

  return (
    <Sheet open={open} onClose={onClose} label="Plan my week" footer={footer}>
      <p className="text-sm text-on-surface-variant">The next seven days</p>
      <p className="display mt-0.5 text-2xl leading-tight font-medium">Plan my week</p>

      {!week && ai?.available && (
        <>
          <p className="mt-3 text-on-surface-variant">
            Almanac puts what's due and what's waited longest on the days with the most room, and leaves some slack. You review it before
            anything moves.
          </p>
          <label className="mt-4 block">
            <span className="text-sm text-on-surface-variant">Anything to keep in mind?</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Keep Saturday free, errands on Thursday…"
              className="mt-1.5 w-full resize-none rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant/70 focus:ring-2 focus:ring-primary"
            />
          </label>
        </>
      )}

      {plan.isError && <p className="mt-3 text-warm">{(plan.error as Error).message}</p>}
      {plan.isPending && !ai?.available && <p className="mt-4 text-on-surface-variant">Planning…</p>}

      {week && (
        <>
          {week.note && <p className="mt-3 rounded-2xl bg-secondary-container px-4 py-3 text-on-secondary-container">{week.note}</p>}
          {week.picks.length === 0 && (
            <p className="mt-4 text-on-surface-variant">Nothing needs a day this week: nothing's due, and the backlog can wait.</p>
          )}
          {week.days.map((d) => {
            const picks = week.picks.filter((p) => p.date === d.date);
            const kept = picks.filter((p) => !skipped.has(p.task.id));
            const minutes = d.plannedMinutes - (picks.length - kept.length ? picks.filter((p) => skipped.has(p.task.id)).reduce((n, p) => n + (p.task.estimateMinutes ?? 30), 0) : 0);
            const load = { ...d, plannedMinutes: minutes };
            return (
              <section key={d.date} className="mt-5">
                <div className="flex items-center gap-3 px-1">
                  <span className="w-9 text-center">
                    <span className="block text-xs text-on-surface-variant">{weekdayShort(d.date)}</span>
                    <span className="display block text-lg leading-none font-medium">{dayOfMonth(d.date)}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between text-sm">
                      <span className="font-medium">{dayLabel(d.date, today)}</span>
                      <span className="text-on-surface-variant">
                        {loadWord(load)} · {minutesLabel(minutes)} of {minutesLabel(d.capacityMinutes)}
                      </span>
                    </span>
                    <LoadBar load={load} className="mt-1.5 h-2" track="bg-surface-highest" />
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1.5">
                  <AnimatePresence initial={false}>
                    {picks.map((p) => (
                      <motion.li
                        key={p.task.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={expressive.fastSpatial}
                        className="flex items-start gap-3 rounded-2xl bg-surface-high p-3"
                      >
                        <Checkbox checked={!skipped.has(p.task.id)} onChange={() => toggle(p.task.id)} label={`Plan ${p.task.title}`} size={24} />
                        <span className={`min-w-0 flex-1 ${skipped.has(p.task.id) ? 'opacity-50' : ''}`}>
                          <span className="block">{p.task.title}</span>
                          <span className="block text-sm text-on-surface-variant">{p.reason}</span>
                        </span>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </section>
            );
          })}
        </>
      )}
    </Sheet>
  );
}

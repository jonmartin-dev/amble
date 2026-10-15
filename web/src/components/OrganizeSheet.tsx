import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import { api, type OrganizeSuggestion } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { refreshViews } from '../lib/mutations.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { Sheet } from './ui.tsx';

type Answer = { suggestions: OrganizeSuggestion[] } | { unavailable: string };

const keyOf = (s: OrganizeSuggestion) => (s.kind === 'merge' ? `merge:${s.taskIds.join()}` : `${s.kind}:${s.taskId}`);

function Card({ s, state, onAccept, onSkip }: { s: OrganizeSuggestion; state: 'open' | 'busy' | 'done'; onAccept: () => void; onSkip: () => void }) {
  const [what, action] =
    s.kind === 'regroup' ? [`Move to ${s.groupName}`, 'Move'] : s.kind === 'merge' ? [`Merge into "${s.title}"`, 'Merge'] : ['Split into separate tasks', 'Split'];
  return (
    <motion.li layout exit={{ opacity: 0, height: 0, marginTop: -8 }} transition={expressive.defaultSpatial} className="rounded-[1.75rem] bg-surface-high p-4">
      <p className="text-sm font-medium text-primary">{what}</p>
      {s.kind === 'merge' ? (
        <ul className="mt-1 list-disc pl-5">
          {s.titles.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1">{s.title}</p>
      )}
      {s.kind === 'split' && (
        <ul className="mt-1 list-disc pl-5 text-on-surface-variant">
          {s.into.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-sm text-on-surface-variant">{s.reason}</p>
      <div className="mt-3 flex gap-2">
        {state === 'done' ? (
          <span className="flex h-10 items-center gap-1.5 rounded-full bg-primary-container px-4 text-sm font-medium text-on-primary-container">
            <Check className="size-5" aria-hidden />
            Done
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={onAccept}
              disabled={state === 'busy'}
              className="h-10 rounded-full bg-primary px-5 text-sm font-medium text-on-primary disabled:opacity-50"
            >
              {action}
            </button>
            <button type="button" onClick={onSkip} className="h-10 rounded-full px-4 text-sm font-medium text-primary hover:bg-surface-highest">
              Skip
            </button>
          </>
        )}
      </div>
    </motion.li>
  );
}

/** The model looks over the backlog and suggests moving, merging or splitting tasks; each one waits for a yes. */
export function OrganizeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, 'busy' | 'done'>>({});
  const look = useMutation({ mutationFn: () => api<Answer>('/organize', { method: 'POST', body: '{}' }) });

  useEffect(() => {
    if (open) look.mutate();
    else {
      look.reset();
      setSkipped(new Set());
      setStates({});
    }
    // Only when the sheet opens or closes.
  }, [open]);

  const accept = async (s: OrganizeSuggestion) => {
    const key = keyOf(s);
    setStates((st) => ({ ...st, [key]: 'busy' }));
    try {
      await api('/organize/apply', { method: 'POST', body: JSON.stringify(s) });
      setStates((st) => ({ ...st, [key]: 'done' }));
      refreshViews(qc);
    } catch (e) {
      setStates(({ [key]: _gone, ...rest }) => rest);
      snack({ message: (e as Error).message });
    }
  };

  const answer = look.data;
  const list = answer && 'suggestions' in answer ? answer.suggestions.filter((s) => !skipped.has(keyOf(s))) : [];

  return (
    <Sheet open={open} onClose={onClose} label="Tidy the backlog">
      <p className="text-sm text-on-surface-variant">Backlog</p>
      <p className="display mt-0.5 text-2xl leading-tight font-medium">Tidy up</p>
      {look.isPending && <p className="mt-4 text-on-surface-variant">Looking over the backlog…</p>}
      {look.isError && <p className="mt-4 text-warm">{(look.error as Error).message}</p>}
      {answer && 'unavailable' in answer && <p className="mt-4 text-on-surface-variant">{answer.unavailable}</p>}
      {answer && 'suggestions' in answer && list.length === 0 && (
        <p className="mt-4 text-on-surface-variant">{answer.suggestions.length ? "That's everything." : 'The backlog already looks tidy.'}</p>
      )}
      <ul className="mt-4 flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {list.map((s) => (
            <Card
              key={keyOf(s)}
              s={s}
              state={states[keyOf(s)] ?? 'open'}
              onAccept={() => void accept(s)}
              onSkip={() => setSkipped((k) => new Set(k).add(keyOf(s)))}
            />
          ))}
        </AnimatePresence>
      </ul>
      <p className="mt-4 mb-2 text-sm text-on-surface-variant">Merged and split tasks are archived, not deleted, so they can be restored from their page.</p>
    </Sheet>
  );
}

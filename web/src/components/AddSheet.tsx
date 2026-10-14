// Quick add from the + button. What's typed comes first, in large type; under it one row of chips
// sets the day, group, person and so on, and a chip's choices open in that same row. With smart
// add on, what's typed goes to Haiku and comes back as proposals to review; otherwise each line is
// added as typed.
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Sparkle from '~icons/material-symbols/auto-awesome-rounded';
import ArrowUp from '~icons/material-symbols/arrow-upward-rounded';
import Close from '~icons/material-symbols/close-rounded';
import Flag from '~icons/material-symbols/flag-rounded';
import Person from '~icons/material-symbols/person-outline-rounded';
import Schedule from '~icons/material-symbols/schedule-outline-rounded';
import TodayIcon from '~icons/material-symbols/today-outline-rounded';
import Folder from '~icons/material-symbols/folder-outline-rounded';
import type { AddHints } from '../../../shared/proposals.ts';
import { api, ApiError, type Proposal, type SmartAddResponse, type TimeOfDay } from '../lib/api.ts';
import { dayLabel, firstName, todayIso } from '../lib/dates.ts';
import { editTask } from '../lib/local.ts';
import { expressive } from '../lib/motion.ts';
import { useSend, useTaskActions } from '../lib/mutations.ts';
import { useAi, useGroups, useMe, useMembers } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { useSyncState } from '../lib/sync.ts';
import { DateChip, GroupChips, PersonChips, TimeChips, WhenChips } from './fields.tsx';
import { GroupIcon } from './icons.tsx';
import { ProposalCard, type Draft } from './ProposalCard.tsx';
import { Sheet } from './ui.tsx';

type Phase = 'compose' | 'thinking' | 'review' | 'done';
type Picker = 'when' | 'group' | 'for' | 'time' | null;
type HintKey = NonNullable<AddHints['explicit']>[number];

interface Applied {
  added: number;
  updated: number;
  completed: number;
  listed: number;
  checked: number;
  taskIds: string[];
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function appliedMessage(r: Applied) {
  const parts = [
    r.added && `added ${plural(r.added, 'task')}`,
    r.listed && `put ${plural(r.listed, 'item')} on a list`,
    r.updated && `changed ${plural(r.updated, 'task')}`,
    r.completed && `finished ${plural(r.completed, 'task')}`,
    r.checked && `checked off ${plural(r.checked, 'item')}`,
  ].filter(Boolean) as string[];
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing changed');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Tapping a chip mustn't take focus from the text box, or the phone's keyboard drops. The date
// input is the exception: it needs focus to open its picker.
const keepKeyboard = (e: React.PointerEvent) => {
  if (!(e.target as HTMLElement).closest('label')) e.preventDefault();
};

/** One option in the row under the text: set (tonal) once picked, outlined until then. */
function OptionChip({ on, icon, onClick, children, label }: { on?: boolean; icon: ReactNode; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`press flex h-9 shrink-0 items-center gap-1.5 rounded-full pr-3.5 pl-2.5 text-sm ${
        on ? 'bg-secondary-container text-on-secondary-container' : 'border border-outline-variant text-on-surface-variant'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

/** M3 Expressive loading shape: a soft blob that morphs and turns while Haiku reads. */
function MorphingShape() {
  return (
    <motion.span
      aria-hidden
      className="absolute inset-1.5 bg-on-primary/25"
      animate={{
        rotate: [0, 120, 240, 360],
        borderRadius: ['42% 58% 55% 45% / 45% 45% 55% 55%', '30%', '58% 42% 38% 62% / 55% 60% 40% 45%', '42% 58% 55% 45% / 45% 45% 55% 55%'],
        scale: [1, 0.86, 1.02, 1],
      }}
      transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

/**
 * Send: a quiet circle until there's something to send, then a filled rounded square (an M3
 * Expressive shape change). While Haiku reads, a shape turns inside it.
 */
function SendButton({ ready, thinking, smart }: { ready: boolean; thinking: boolean; smart: boolean }) {
  const active = ready || thinking;
  return (
    <motion.button
      type="submit"
      onPointerDown={(e) => e.preventDefault()}
      disabled={!ready || thinking}
      aria-label={thinking ? 'Reading it' : smart ? 'Read it' : 'Add'}
      initial={false}
      animate={{ borderRadius: active ? 18 : 28 }}
      whileTap={{ scale: 0.9, borderRadius: 14 }}
      transition={expressive.fastSpatial}
      className={`relative grid size-14 shrink-0 place-items-center overflow-hidden transition-colors duration-200 ${
        active ? 'bg-primary text-on-primary' : 'bg-surface-highest text-on-surface-variant'
      }`}
    >
      {thinking && <MorphingShape />}
      {smart ? <Sparkle className="relative size-6" aria-hidden /> : <ArrowUp className="relative size-6" aria-hidden />}
    </motion.button>
  );
}

/** The moment it's saved: a check draws itself, then the sheet goes. */
function Done({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center py-5 text-center">
      <motion.span
        initial={{ scale: 0, rotate: -90, borderRadius: '50%' }}
        animate={{ scale: 1, rotate: 0, borderRadius: '32%' }}
        transition={expressive.fastSpatial}
        className="grid size-16 place-items-center bg-primary text-on-primary"
      >
        <svg viewBox="0 0 24 24" className="size-9" aria-hidden>
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: 0.12, duration: 0.32, ease: [0.2, 0, 0, 1] }}
          />
        </svg>
      </motion.span>
      <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...expressive.defaultSpatial, delay: 0.1 }} className="mt-3 font-medium">
        {message}
      </motion.p>
    </div>
  );
}

const phaseMotion = {
  initial: { opacity: 0, y: 14, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -10, scale: 0.98 },
  transition: expressive.defaultSpatial,
};

// The chip row and a chip's choices slide past each other in the same place.
const rowMotion = (forward: boolean) => ({
  initial: { opacity: 0, x: forward ? 24 : -24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: forward ? -24 : 24 },
  transition: expressive.fastSpatial,
});

// Browsers without `field-sizing` (Safari, for now) get the text box grown by hand.
const sizesItself = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

export function AddSheet({ open, onClose, plannedByDefault }: { open: boolean; onClose: () => void; plannedByDefault: boolean }) {
  const me = useMe();
  const { data: groups = [] } = useGroups();
  const { data: household } = useMembers();
  const { data: ai } = useAi();
  const actions = useTaskActions();
  const send = useSend();
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { online } = useSyncState();
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  // Shift+Enter on a keyboard starts a new line; any other line break is the send key.
  const newLine = useRef(false);
  const today = todayIso();
  // Smart add needs Haiku, so offline everything goes in as typed.
  const smart = (ai?.smartAdd ?? false) && online;
  const smartOffline = (ai?.smartAdd ?? false) && !online;
  const members = household?.members ?? [];

  const [text, setText] = useState('');
  const [planned, setPlanned] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null | undefined>(undefined);
  const [time, setTime] = useState<TimeOfDay | null>(null);
  const [mustDo, setMustDo] = useState(false);
  const [explicit, setExplicit] = useState<Set<HintKey>>(new Set());
  const [picker, setPicker] = useState<Picker>(null);
  const [phase, setPhase] = useState<Phase>('compose');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');

  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      return;
    }
    setText('');
    setPlanned(plannedByDefault ? today : null);
    setDue(null);
    setGroupId(null);
    setAssignee(undefined);
    setTime(null);
    setMustDo(false);
    setExplicit(new Set());
    setPicker(null);
    setPhase('compose');
    setDrafts([]);
    setNotice(null);
  }, [open, plannedByDefault, today]);

  // Focus while the tap that opened the sheet is still being handled, or phones won't raise the keyboard.
  useLayoutEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    const el = input.current;
    if (sizesItself || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text, phase]);

  const pick = <T,>(key: HintKey, set: (v: T) => void) => (v: T) => {
    set(v);
    setExplicit((s) => new Set(s).add(key));
    setPicker(null);
  };

  const refresh = () => {
    for (const key of ['today', 'tasks', 'task', 'load', 'groups', 'activity', 'stats', 'list', 'ai']) void qc.invalidateQueries({ queryKey: [key] });
  };

  // Without smart add (or when it can't help), each line becomes a task with the chips' settings.
  const addAsTyped = (raw: string, why?: string) => {
    const titles = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const title of titles) {
      actions.create({ title, plannedDate: planned, dueDate: due, groupId, assigneeId: assignee, timeOfDay: time, mustDo });
    }
    setText('');
    setMustDo(false);
    setPhase('compose');
    setDrafts([]);
    setNotice(`${why ? `${why} ` : ''}Added ${titles.length === 1 ? `"${titles[0]}"` : plural(titles.length, 'task')}.`);
    input.current?.focus({ preventScroll: true });
  };

  const hints = (): AddHints => ({
    plannedDate: planned,
    ...(explicit.has('dueDate') && { dueDate: due }),
    ...(explicit.has('groupId') && { groupId }),
    ...(explicit.has('assigneeId') && { assigneeId: assignee === undefined ? (me?.id ?? null) : assignee }),
    ...(explicit.has('timeOfDay') && { timeOfDay: time }),
    ...(explicit.has('mustDo') && { mustDo }),
    explicit: [...explicit],
  });

  const submit = async (typed = text) => {
    const t = typed.trim();
    if (!t || phase === 'thinking') return;
    if (!smart) return addAsTyped(t);
    setPicker(null);
    setNotice(null);
    setPhase('thinking');
    // Dismiss the keyboard so the proposals have the screen.
    input.current?.blur();
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await api<SmartAddResponse>('/smart-add', { method: 'POST', body: JSON.stringify({ text: t, hints: hints() }), signal: ctrl.signal });
      if ('fallback' in res) return addAsTyped(t, "Smart add isn't available right now, so it went in as typed.");
      if (res.proposals.length === 0) {
        setPhase('compose');
        setNotice(res.unclear ?? "Smart add couldn't make anything of that. Try different words, or add it as typed.");
        return;
      }
      setDrafts(res.proposals.map((proposal, i) => ({ key: `${Date.now()}-${i}`, include: true, proposal })));
      setOpenCard(null);
      setNotice(res.unclear);
      setPhase('review');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof ApiError && e.status === 0) return addAsTyped(t, "You're offline, so it went in as typed.");
      setPhase('compose');
      setNotice(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const cancelThinking = () => {
    abort.current?.abort();
    setPhase('compose');
    input.current?.focus({ preventScroll: true });
  };

  const chosen = drafts.filter((d) => d.include);
  const valid = chosen.every((d) => (d.proposal.kind === 'task' ? d.proposal.task.title.trim() : d.proposal.kind === 'list_item' ? d.proposal.name.trim() : true));

  const apply = () => {
    if (!chosen.length || !valid) return;
    setApplying(true);
    api<Applied>('/smart-add/apply', { method: 'POST', body: JSON.stringify({ proposals: chosen.map((d) => d.proposal) }) })
      .then((r) => {
        refresh();
        const onlyTasks = r.added > 0 && r.added === chosen.length;
        setDoneMessage(appliedMessage(r));
        setPhase('done');
        // Let the check draw, then get out of the way; the snackbar keeps Undo within reach.
        setTimeout(() => {
          onClose();
          snack({
            message: appliedMessage(r),
            action: onlyTasks
              ? {
                  label: 'Undo',
                  run: () => {
                    for (const id of r.taskIds) {
                      editTask(qc, id, () => ({ status: 'archived' }));
                      send('POST', `/tasks/${id}/archive`, {}, 'Undo smart add');
                    }
                  },
                }
              : undefined,
          });
        }, 750);
      })
      .catch((e: Error) => setNotice(e.message))
      .finally(() => setApplying(false));
  };

  const group = groups.find((g) => g.id === groupId);
  const person = assignee === undefined ? 'Me' : assignee === null ? 'Anyone' : firstName(members.find((m) => m.id === assignee)?.name ?? '');
  const ctx = { today, me: me?.id ?? '', groups, members };
  const toggle = (p: Exclude<Picker, null>) => () => setPicker(picker === p ? null : p);
  const icon = 'size-[1.125rem]';

  // The row under the text: the options, or one option's choices in their place.
  const chips = (
    <div className="flex gap-1.5 overflow-x-auto pr-6 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]">
      <OptionChip on={planned !== null} icon={<TodayIcon className={icon} aria-hidden />} onClick={toggle('when')}>
        {planned ? dayLabel(planned, today) : 'Someday'}
      </OptionChip>
      <OptionChip on={!!group} icon={group ? <GroupIcon name={group.icon} className={icon} /> : <Folder className={icon} aria-hidden />} onClick={toggle('group')}>
        {group?.name ?? 'Group'}
      </OptionChip>
      {members.length > 1 && (
        <OptionChip on={assignee !== undefined} icon={<Person className={icon} aria-hidden />} onClick={toggle('for')}>
          {person}
        </OptionChip>
      )}
      <OptionChip on={!!time} icon={<Schedule className={icon} aria-hidden />} onClick={toggle('time')}>
        {time ? <span className="capitalize">{time}</span> : 'Any time'}
      </OptionChip>
      <OptionChip on={mustDo} icon={<Flag className={icon} aria-hidden />} onClick={() => pick('mustDo', setMustDo)(!mustDo)}>
        Must do
      </OptionChip>
      <DateChip keepFocus value={due} min={today} label={due ? `Due ${dayLabel(due, today, true)}` : 'Due'} onPick={pick('dueDate', setDue)} />
    </div>
  );
  const choices = picker && (
    <div className="flex gap-1.5 overflow-x-auto pr-6 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]">
      <button
        type="button"
        onClick={() => setPicker(null)}
        aria-label="Back to the options"
        className="press grid size-9 shrink-0 place-items-center rounded-full bg-surface-highest text-on-surface-variant"
      >
        <Close className="size-5" aria-hidden />
      </button>
      {picker === 'when' && <WhenChips value={planned} today={today} onChange={pick('plannedDate', setPlanned)} />}
      {picker === 'group' && <GroupChips groups={groups} value={groupId} onChange={pick('groupId', setGroupId)} />}
      {picker === 'for' && (
        <PersonChips
          members={members}
          me={me?.id ?? ''}
          value={assignee === undefined ? (me?.id ?? null) : assignee}
          onChange={pick('assigneeId', (v: string | null) => setAssignee(v === me?.id ? undefined : v))}
        />
      )}
      {picker === 'time' && <TimeChips value={time} onChange={pick('timeOfDay', setTime)} />}
    </div>
  );

  const thinking = phase === 'thinking';
  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="relative">
        <textarea
          ref={input}
          rows={1}
          value={text}
          onChange={(e) => {
            const el = e.target;
            const { inputType, data } = e.nativeEvent as InputEvent;
            // Phone keyboards often send their Enter (here, send) as a typed line break rather
            // than a key press. Take it out again and send what's there.
            const lineBreak = inputType === 'insertLineBreak' || inputType === 'insertParagraph' || (inputType?.startsWith('insert') && inputType !== 'insertFromPaste' && data === '\n');
            if (lineBreak && !newLine.current) {
              const at = el.selectionStart;
              const typed = el.value.slice(0, Math.max(0, at - 1)) + el.value.slice(at);
              setText(typed);
              void submit(typed);
              return;
            }
            newLine.current = false;
            setText(el.value);
          }}
          onKeyDown={(e) => {
            newLine.current = e.key === 'Enter' && e.shiftKey;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={smart ? 'Call Mom Friday, out of eggs…' : 'What needs doing?'}
          aria-label={smart ? 'What to add' : 'Task'}
          enterKeyHint="send"
          readOnly={thinking}
          className={`field-sizing-content block max-h-42 min-h-14 w-full resize-none bg-transparent px-1 pt-1 text-[1.375rem] leading-8 outline-none placeholder:text-on-surface-variant/70 ${
            thinking ? 'text-transparent' : ''
          }`}
        />
        {/* While Haiku reads, a light sweeps across what they typed. */}
        {thinking && (
          <motion.p
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden bg-clip-text px-1 pt-1 text-[1.375rem] leading-8 whitespace-pre-wrap text-transparent"
            style={{
              backgroundImage: 'linear-gradient(100deg, var(--md-on-surface-variant) 35%, var(--md-primary) 50%, var(--md-on-surface-variant) 65%)',
              backgroundSize: '250% 100%',
            }}
            animate={{ backgroundPosition: ['100% 0%', '0% 0%'] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
          >
            {text}
          </motion.p>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="relative min-w-0 flex-1 overflow-hidden" onPointerDown={keepKeyboard}>
          <AnimatePresence mode="popLayout" initial={false}>
            {thinking ? (
              <motion.div key="thinking" {...rowMotion(true)} className="flex h-9 items-center gap-3">
                <span className="text-sm font-medium text-primary">Reading that…</span>
                <button type="button" onClick={cancelThinking} className="rounded-full px-3 py-1.5 text-sm font-medium text-on-surface-variant hover:bg-surface-high">
                  Cancel
                </button>
              </motion.div>
            ) : picker ? (
              <motion.div key={picker} {...rowMotion(true)}>
                {choices}
              </motion.div>
            ) : (
              <motion.div key="options" {...rowMotion(false)}>
                {chips}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <SendButton ready={!!text.trim()} thinking={thinking} smart={smart} />
      </div>
    </form>
  );

  const reviewFooter = (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => {
          setPhase('compose');
          setDrafts([]);
          setNotice(null);
          // The text box comes back on the next frame; focus it once it exists.
          requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
        }}
        className="press h-14 flex-1 rounded-full bg-surface-highest font-medium"
      >
        Edit text
      </button>
      <button
        type="button"
        onClick={apply}
        disabled={!chosen.length || !valid || applying}
        className="press h-14 flex-[1.4] rounded-full bg-primary font-medium text-on-primary disabled:opacity-40"
      >
        {applying ? 'Adding…' : chosen.length === drafts.length && chosen.length > 1 ? `Add all ${chosen.length}` : chosen.length ? `Add ${chosen.length}` : 'Nothing picked'}
      </button>
    </div>
  );

  // Only what's worth saying: what came back, or why it's adding things as typed.
  const header =
    phase === 'review' ? (
      <p className="flex items-center gap-1.5 pb-1 text-sm text-on-surface-variant">
        <Sparkle className="size-4 text-primary" aria-hidden />
        Here's what I got. Tap one to change it.
      </p>
    ) : phase === 'compose' && smartOffline ? (
      <p className="pb-1 text-sm text-on-surface-variant">You're offline, so it goes in as typed.</p>
    ) : null;

  let body: ReactNode = null;
  if (phase === 'done') body = <Done message={doneMessage} />;
  else if (phase === 'review') {
    body = (
      <>
        {notice && <p className="mb-2 rounded-2xl bg-warm-container px-3 py-2 text-sm text-on-warm-container">{notice}</p>}
        <ul className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <ProposalCard
              key={d.key}
              index={i}
              draft={d}
              ctx={ctx}
              open={openCard === d.key}
              onToggleOpen={() => setOpenCard(openCard === d.key ? null : d.key)}
              onChange={(proposal: Proposal) => setDrafts((all) => all.map((x) => (x.key === d.key ? { ...x, proposal } : x)))}
              onInclude={(include) => setDrafts((all) => all.map((x) => (x.key === d.key ? { ...x, include } : x)))}
            />
          ))}
        </ul>
        <button type="button" onClick={() => addAsTyped(text.trim())} className="mt-3 mb-1 w-full py-2 text-sm text-on-surface-variant underline-offset-4 hover:underline">
          Add it as typed instead
        </button>
      </>
    );
  } else if (notice) {
    body = <p className="rounded-2xl bg-surface-high px-3.5 py-2.5 text-sm text-on-surface-variant">{notice}</p>;
  }

  // Each phase crossfades into the next while the sheet glides to its new height.
  const bodyKey = phase === 'compose' || phase === 'thinking' ? `compose-${notice ?? ''}` : phase;
  const footer = phase === 'done' ? null : phase === 'review' ? reviewFooter : composer;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label="Add"
      header={header}
      footer={
        footer && (
          <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={phase === 'review' ? 'review' : 'compose'} {...phaseMotion}>
                {footer}
              </motion.div>
            </AnimatePresence>
          </div>
        )
      }
    >
      <div className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          {body && (
            <motion.div key={bodyKey} {...phaseMotion}>
              {body}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}

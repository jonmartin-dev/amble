// Quick add from the + button. What's typed comes first, in large type; under it one row of chips
// sets the day, group, person and so on, and a chip's choices open in that same row. With smart
// add on, what's typed goes to the model and comes back as proposals to review, each card showing up
// as the model writes it; otherwise each line is added as typed.
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
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import RepeatIcon from '~icons/material-symbols/repeat-rounded';
import type { AddHints } from '../../../shared/proposals.ts';
import { parseQuick, quickTitle, type QuickField } from '../../../shared/quick.ts';
import { describeRepeat } from '../../../shared/repeat.ts';
import { api, ApiError, apiLines, type Group, type Proposal, type SmartAddLine, type SmartAddResult, type TimeOfDay } from '../lib/api.ts';
import { dayLabel, firstName, reminderPhrase, todayIso } from '../lib/dates.ts';
import { editTask } from '../lib/local.ts';
import { expressive } from '../lib/motion.ts';
import { useMotion } from '../lib/motion-settings.ts';
import { peekOrigin } from '../lib/morph.ts';
import { native } from '../lib/native.ts';
import { useSend, useTaskActions } from '../lib/mutations.ts';
import { useAi, useGroups, useMe, useMembers } from '../lib/queries.ts';
import { useSyncState } from '../lib/sync.ts';
import { DateChip, GroupChips, PersonChips, TimeChips, WhenChips } from './fields.tsx';
import { GroupIcon } from './icons.tsx';
import { ProposalCard, type Draft } from './ProposalCard.tsx';
import { LoadingShape, ShimmerText, WaitingCard } from './SmartReading.tsx';
import { DoneMark, ScrollRow, Sheet } from './ui.tsx';

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
      aria-pressed={on ?? false}
      className="chip"
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Send: a quiet circle until there's something to send, then a filled rounded square (an M3
 * Expressive shape change). While the model reads, a shape turns inside it.
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
      whileTap={{ borderRadius: 12 }}
      transition={expressive.fastSpatial}
      className={`relative grid size-14 shrink-0 place-items-center overflow-hidden transition-colors duration-200 ${
        active ? 'bg-primary text-on-primary' : 'bg-surface-highest text-on-surface-variant'
      }`}
    >
      {thinking && <LoadingShape className="absolute inset-1" tone="bg-on-primary/25" />}
      {smart ? <Sparkle className="relative size-6" aria-hidden /> : <ArrowUp className="relative size-6" aria-hidden />}
    </motion.button>
  );
}

/** The moment it's saved: a check draws itself, with Undo in reach until the sheet goes. */
function Done({ message, onUndo }: { message: string; onUndo: (() => void) | null }) {
  return (
    <div className="flex flex-col items-center py-5 text-center">
      <DoneMark />
      <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...expressive.defaultSpatial, delay: 0.1 }} className="mt-3 font-medium">
        {message}
      </motion.p>
      {onUndo && (
        <motion.button
          type="button"
          onClick={onUndo}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...expressive.defaultSpatial, delay: 0.18 }}
          className="press mt-3 h-10 rounded-full px-5 text-sm font-medium text-primary hover:bg-surface-high"
        >
          Undo
        </motion.button>
      )}
    </div>
  );
}

// How long the sheet stays on what was added, with Undo, before it goes.
const DONE_MS = 4000;

// The text box gives way to the review's buttons without the two crossing.
const handOver = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { ...expressive.defaultSpatial, delay: 0.08 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

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

/** A local date and minutes after midnight, as a moment. */
function localTime(date: string, minutes: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, Math.floor(minutes / 60), minutes % 60);
}

/** The group a #word names: its name run together ("#homeoffice"), or the start of it ("#err"). */
function groupNamed(groups: Group[], word: string) {
  const flat = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const w = flat(word);
  const tasks = groups.filter((g) => g.kind === 'tasks');
  return tasks.find((g) => flat(g.name) === w) ?? (w.length >= 2 ? tasks.find((g) => flat(g.name).startsWith(w)) : undefined);
}

/** Whether an @word is this person: their first name. */
const sameName = (m: { name: string }, word: string) => firstName(m.name).toLowerCase() === word.toLowerCase();

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
  const { online } = useSyncState();
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  // Shift+Enter on a keyboard starts a new line; any other line break is the send key.
  const newLine = useRef(false);
  const today = todayIso();
  // Smart add needs the model, so offline everything goes in as typed.
  const smart = (ai?.smartAdd ?? false) && online;
  const smartOffline = (ai?.smartAdd ?? false) && !online;
  const members = household?.members ?? [];
  const { morphAdd } = useMotion();

  const [text, setText] = useState('');
  const [planned, setPlanned] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null | undefined>(undefined);
  const [time, setTime] = useState<TimeOfDay | null>(null);
  const [mustDo, setMustDo] = useState(false);
  const [explicit, setExplicit] = useState<Set<HintKey>>(new Set());
  // A reminder or repeat read from the text that the person took off again.
  const [dropped, setDropped] = useState<Set<'remindAt' | 'repeat'>>(new Set());
  const [picker, setPicker] = useState<Picker>(null);
  const [phase, setPhase] = useState<Phase>('compose');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // While the model is still writing: the cards so far are up, and how many came that way.
  const [streaming, setStreaming] = useState(false);
  const [arrived, setArrived] = useState(0);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');
  // What was just added, to take off again with Undo: tasks put in by smart add, or the lines typed.
  const [added, setAdded] = useState<{ ids: string[]; typed?: string } | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Each time it opens it starts afresh, before it's first drawn: after a review or a "done", the
  // text box has to be there already for the focus below to raise the keyboard.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText('');
      setPlanned(plannedByDefault ? today : null);
      setDue(null);
      setGroupId(null);
      setAssignee(undefined);
      setTime(null);
      setMustDo(false);
      setExplicit(new Set());
      setDropped(new Set());
      setPicker(null);
      setPhase('compose');
      setDrafts([]);
      setStreaming(false);
      setNotice(null);
      setAdded(null);
    }
  }
  useEffect(() => {
    if (open) return;
    abort.current?.abort();
    // Closed some other way first: the timer mustn't close it again once it's reopened.
    clearTimeout(closing.current);
  }, [open]);

  // Grown out of the + that was tapped (Material's container transform), when it was.
  const origin = morphAdd && open ? peekOrigin('add') : null;
  // Focus while the tap that opened the sheet is still being handled, or phones won't raise the
  // keyboard. The Android app raises it later too, and there, while the sheet grows out of the +,
  // the keyboard waits for it: rising sooner, it would shove the sheet up halfway through.
  const waitForGrow = native && !!origin;
  useLayoutEffect(() => {
    if (!open) return;
    if (!waitForGrow) return input.current?.focus({ preventScroll: true });
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 380);
    return () => clearTimeout(t);
    // Only as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * A line as a task: its day, time, reminder and the rest read from the words (shared/quick.ts),
   * with whatever chip the person tapped winning, and the words of what was used taken out.
   */
  const readLine = (line: string) => {
    const p = parseQuick(line, today);
    const auto = (key: HintKey) => !explicit.has(key);
    const used: QuickField[] = [];
    const take = <T,>(field: QuickField, key: HintKey | null, value: T | undefined, fallback: T): T => {
      if (value === undefined || (key && !auto(key))) return fallback;
      used.push(field);
      return value;
    };
    const matchedGroup = p.group ? groupNamed(groups, p.group) : undefined;
    const matchedPerson = p.person ? members.find((m) => sameName(m, p.person!)) : undefined;
    const task = {
      plannedDate: take('plannedDate', 'plannedDate', p.plannedDate, planned),
      dueDate: take('dueDate', 'dueDate', p.dueDate, due),
      timeOfDay: take('timeOfDay', 'timeOfDay', p.timeOfDay, time),
      mustDo: take('mustDo', 'mustDo', p.mustDo, mustDo),
      groupId: take('group', 'groupId', matchedGroup?.id, groupId),
      assigneeId: take('person', 'assigneeId', matchedPerson ? (matchedPerson.id === me?.id ? undefined : matchedPerson.id) : undefined, assignee),
      remindAt: dropped.has('remindAt') ? undefined : take('remindAt', null, p.remindAt, undefined),
      repeat: dropped.has('repeat') ? undefined : take('repeat', null, p.repeat, undefined),
    };
    return { title: quickTitle(line, p, used) || line.trim(), ...task };
  };

  // Without smart add (or when it can't help), each line becomes a task, read for its day and the rest.
  const addAsTyped = (raw: string, why?: string) => {
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const titles: string[] = [];
    const ids: string[] = [];
    for (const line of lines) {
      const { remindAt, ...t } = readLine(line);
      titles.push(t.title);
      // The parser moves a reminder that's gone by; this is for one that went by while the sheet was open.
      const at = remindAt ? localTime(remindAt.date, remindAt.minutes) : null;
      ids.push(actions.create({ ...t, remindAt: at && at > new Date() ? at.toISOString() : null }).id);
    }
    setAdded({ ids, typed: raw });
    setText('');
    setMustDo(false);
    setDropped(new Set());
    setPhase('compose');
    setDrafts([]);
    setStreaming(false);
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
    setDrafts([]);
    setArrived(0);
    setOpenCard(null);
    // Each proposal shows as a card the moment the model has written it; the first one swaps the
    // text box for the review, and the rest join it until the answer is done.
    const batch = Date.now();
    let got = 0;
    let result: SmartAddResult | null = null;
    let fallback: string | null = null;
    let failed: string | null = null;
    const draft = (proposal: Proposal, i: number): Draft => ({ key: `${batch}-${i}`, include: true, proposal });
    try {
      await apiLines<SmartAddLine>('/smart-add', { method: 'POST', body: JSON.stringify({ text: t, hints: hints(), stream: true }), signal: ctrl.signal }, (line) => {
        if (ctrl.signal.aborted) return;
        if ('proposal' in line) {
          const d = draft(line.proposal, got++);
          setDrafts((all) => [...all, d]);
          setArrived(got);
          if (got === 1) {
            setStreaming(true);
            setPhase('review');
          }
        } else if ('result' in line) result = line.result;
        else if ('fallback' in line) fallback = line.fallback;
        else if ('error' in line) failed = line.error;
        // A server without streaming answers all at once, which comes as one line here.
        else if ('proposals' in line) result = line;
      });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (got === 0 && e instanceof ApiError && e.status === 0) return addAsTyped(t, "You're offline, so it went in as typed.");
      failed = e instanceof Error ? e.message : 'Something went wrong.';
    }
    if (ctrl.signal.aborted) return;
    setStreaming(false);
    const done = result as SmartAddResult | null;
    if (done && done.proposals.length) {
      // Anything the cards so far didn't cover (all of it, from a server that doesn't stream).
      const rest = done.proposals.slice(got).map((p, i) => draft(p, got + i));
      if (rest.length) setDrafts((all) => [...all, ...rest]);
      setNotice(done.unclear);
      setPhase('review');
    } else if (got > 0) {
      // It stopped partway: what it got to stays up to check.
      setNotice('Smart add stopped partway through, so check these and add the rest yourself.');
    } else if (fallback) addAsTyped(t, "Smart add isn't available right now, so it went in as typed.");
    else if (done) {
      setPhase('compose');
      setNotice(done.unclear ?? "Smart add couldn't make anything of that. Try different words, or add it as typed.");
    } else {
      setPhase('compose');
      setNotice(failed ?? 'Something went wrong.');
    }
  };

  const takeOff = (ids: string[]) => {
    for (const id of ids) {
      editTask(qc, id, () => ({ status: 'archived' }));
      send('POST', `/tasks/${id}/archive`, {}, 'Undo add');
    }
  };
  const undo = () => {
    if (!added) return;
    clearTimeout(closing.current);
    takeOff(added.ids);
    setNotice(null);
    setAdded(null);
    if (added.typed !== undefined) {
      // What was typed comes back to fix, unless something new is being typed already.
      if (!text.trim()) setText(added.typed);
      input.current?.focus({ preventScroll: true });
    } else setPhase('review');
  };

  const cancelThinking = () => {
    abort.current?.abort();
    setStreaming(false);
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
        setAdded(onlyTasks ? { ids: r.taskIds } : null);
        setPhase('done');
        // The check draws, Undo stays in reach a moment, then the sheet gets out of the way.
        clearTimeout(closing.current);
        closing.current = setTimeout(onClose, DONE_MS);
      })
      .catch((e: Error) => setNotice(e.message))
      .finally(() => setApplying(false));
  };

  // As it's typed (one line, without smart add), the chips show what the words say.
  const reading = !smart && text.trim() && !text.includes('\n') ? readLine(text) : null;
  const shown = reading ?? { plannedDate: planned, dueDate: due, timeOfDay: time, mustDo, groupId, assigneeId: assignee, remindAt: undefined, repeat: undefined };
  const group = groups.find((g) => g.id === shown.groupId);
  const person =
    shown.assigneeId === undefined ? 'Me' : shown.assigneeId === null ? 'Anyone' : firstName(members.find((m) => m.id === shown.assigneeId)?.name ?? '');
  const ctx = { today, me: me?.id ?? '', groups, members };
  const toggle = (p: Exclude<Picker, null>) => () => setPicker(picker === p ? null : p);
  const icon = 'size-[1.125rem]';

  // The row under the text: the options, or one option's choices in their place.
  const chips = (
    <ScrollRow className="flex gap-1.5 overflow-x-auto pr-6">
      <OptionChip on={shown.plannedDate !== null} icon={<TodayIcon className={icon} aria-hidden />} onClick={toggle('when')}>
        {shown.plannedDate ? dayLabel(shown.plannedDate, today) : 'Someday'}
      </OptionChip>
      <OptionChip on={!!group} icon={group ? <GroupIcon name={group.icon} className={icon} /> : <Folder className={icon} aria-hidden />} onClick={toggle('group')}>
        {group?.name ?? 'Group'}
      </OptionChip>
      {members.length > 1 && (
        <OptionChip on={shown.assigneeId !== undefined} icon={<Person className={icon} aria-hidden />} onClick={toggle('for')}>
          {person}
        </OptionChip>
      )}
      <OptionChip on={!!shown.timeOfDay} icon={<Schedule className={icon} aria-hidden />} onClick={toggle('time')}>
        {shown.timeOfDay ? <span className="capitalize">{shown.timeOfDay}</span> : 'Any time'}
      </OptionChip>
      <OptionChip on={shown.mustDo} icon={<Flag className={icon} aria-hidden />} onClick={() => pick('mustDo', setMustDo)(!shown.mustDo)}>
        Must do
      </OptionChip>
      <DateChip
        keepFocus
        value={shown.dueDate}
        min={today}
        label={shown.dueDate ? `Due ${dayLabel(shown.dueDate, today, true)}` : 'Due'}
        onPick={pick('dueDate', setDue)}
      />
    </ScrollRow>
  );
  const choices = picker && (
    <ScrollRow className="flex gap-1.5 overflow-x-auto pr-6">
      <button
        type="button"
        onClick={() => setPicker(null)}
        aria-label="Back to the options"
        className="press grid size-9 shrink-0 place-items-center rounded-full bg-surface-highest text-on-surface-variant"
      >
        <Close className="size-5" aria-hidden />
      </button>
      {picker === 'when' && <WhenChips value={shown.plannedDate} today={today} onChange={pick('plannedDate', setPlanned)} />}
      {picker === 'group' && <GroupChips groups={groups} value={shown.groupId} onChange={pick('groupId', setGroupId)} />}
      {picker === 'for' && (
        <PersonChips
          members={members}
          me={me?.id ?? ''}
          value={shown.assigneeId === undefined ? (me?.id ?? null) : shown.assigneeId}
          onChange={pick('assigneeId', (v: string | null) => setAssignee(v === me?.id ? undefined : v))}
        />
      )}
      {picker === 'time' && <TimeChips value={shown.timeOfDay} onChange={pick('timeOfDay', setTime)} />}
    </ScrollRow>
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
        {/* While the model reads, a light sweeps across what they typed. */}
        {thinking && (
          <ShimmerText text={text} className="pointer-events-none absolute inset-0 overflow-hidden" lines="px-1 pt-1 text-[1.375rem] leading-8 whitespace-pre-wrap" />
        )}
      </div>
      {!thinking && reading && (reading.remindAt || reading.repeat) && (
        // What the words asked for that has no chip of its own; a tap takes it off again.
        <div className="mt-2 flex flex-wrap gap-1.5" onPointerDown={keepKeyboard}>
          {reading.remindAt && (
            <button type="button" onClick={() => setDropped((d) => new Set(d).add('remindAt'))} className="chip chip-on">
              <Bell aria-hidden />
              Remind me {reminderPhrase(localTime(reading.remindAt.date, reading.remindAt.minutes))}
              <Close className="-mr-2" aria-label="Take it off" />
            </button>
          )}
          {reading.repeat && (
            <button type="button" onClick={() => setDropped((d) => new Set(d).add('repeat'))} className="chip chip-on">
              <RepeatIcon aria-hidden />
              {describeRepeat(reading.repeat, reading.plannedDate)}
              <Close className="-mr-2" aria-label="Take it off" />
            </button>
          )}
        </div>
      )}
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
          abort.current?.abort();
          setStreaming(false);
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
        disabled={streaming || !chosen.length || !valid || applying}
        className="press h-14 flex-[1.4] rounded-full bg-primary font-medium text-on-primary disabled:opacity-40"
      >
        {streaming ? 'Reading…' : applying ? 'Adding…' : chosen.length === drafts.length && chosen.length > 1 ? `Add all ${chosen.length}` : chosen.length ? `Add ${chosen.length}` : 'Nothing picked'}
      </button>
    </div>
  );

  // Only what's worth saying: what came back, or why it's adding things as typed.
  const header =
    phase === 'review' ? (
      <p className="flex items-center gap-1.5 pb-1 text-sm text-on-surface-variant">
        <Sparkle className="size-4 text-primary" aria-hidden />
        {streaming ? 'Reading the rest…' : "Here's what I got. Tap one to change it."}
      </p>
    ) : phase === 'compose' && smartOffline ? (
      <p className="pb-1 text-sm text-on-surface-variant">You're offline, so it goes in as typed.</p>
    ) : null;

  let body: ReactNode = null;
  if (phase === 'done') body = <Done message={doneMessage} onUndo={added ? undo : null} />;
  else if (phase === 'review') {
    body = (
      <>
        {notice && <p className="mb-2 rounded-2xl bg-warm-container px-3 py-2 text-sm text-on-warm-container">{notice}</p>}
        <ul className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <ProposalCard
              key={d.key}
              // Cards that came one by one arrive as they come; ones that came together, one after another.
              index={Math.max(0, i - arrived)}
              draft={d}
              ctx={ctx}
              open={openCard === d.key}
              onToggleOpen={() => setOpenCard(openCard === d.key ? null : d.key)}
              onChange={(proposal: Proposal) => setDrafts((all) => all.map((x) => (x.key === d.key ? { ...x, proposal } : x)))}
              onInclude={(include) => setDrafts((all) => all.map((x) => (x.key === d.key ? { ...x, include } : x)))}
            />
          ))}
          <AnimatePresence>{streaming && <WaitingCard key="waiting" />}</AnimatePresence>
        </ul>
        <button
          type="button"
          onClick={() => {
            abort.current?.abort();
            addAsTyped(text.trim());
          }}
          className="mt-3 mb-1 w-full py-2 text-sm text-on-surface-variant underline-offset-4 hover:underline"
        >
          Add it as typed instead
        </button>
      </>
    );
  } else if (notice) {
    body = (
      <div className="flex items-center gap-2 rounded-2xl bg-surface-high py-1 pr-1 pl-3.5">
        <p className="flex-1 py-1.5 text-sm text-on-surface-variant">{notice}</p>
        {added?.typed !== undefined && (
          <button type="button" onClick={undo} onPointerDown={keepKeyboard} className="press h-9 shrink-0 rounded-full px-3 text-sm font-medium text-primary">
            Undo
          </button>
        )}
      </div>
    );
  }

  // Each phase crossfades into the next while the sheet glides to its new height.
  const bodyKey = phase === 'compose' || phase === 'thinking' ? `compose-${notice ?? ''}` : phase;
  const footer = phase === 'done' ? null : phase === 'review' ? reviewFooter : composer;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      origin={origin}
      label="Add"
      header={header}
      footer={
        footer && (
          <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={phase === 'review' ? 'review' : 'compose'} {...handOver}>
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

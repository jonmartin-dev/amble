import { useNavigate, useRouter } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import Close from '~icons/material-symbols/close-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import Delete from '~icons/material-symbols/delete-outline-rounded';
import Event from '~icons/material-symbols/event-outline-rounded';
import EventBusy from '~icons/material-symbols/event-busy-outline-rounded';
import Flag from '~icons/material-symbols/flag-outline-rounded';
import Folder from '~icons/material-symbols/folder-outline-rounded';
import LinkIcon from '~icons/material-symbols/link-rounded';
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import OpenInNew from '~icons/material-symbols/open-in-new-rounded';
import Person from '~icons/material-symbols/person-outline-rounded';
import RepeatIcon from '~icons/material-symbols/repeat-rounded';
import Schedule from '~icons/material-symbols/schedule-outline-rounded';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Timer from '~icons/material-symbols/timer-outline-rounded';
import { ActivityRow } from '../components/ActivityList.tsx';
import { GroupIcon } from '../components/icons.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { ReminderField, ReminderSheet } from '../components/ReminderSheet.tsx';
import { RepeatSheet } from '../components/RepeatSheet.tsx';
import { TaskFiles } from '../components/TaskFiles.tsx';
import { TripCard } from '../components/TripList.tsx';
import { describeRepeat, repeatOn } from '../../../shared/repeat.ts';
import { BackButton, Checkbox, Chip, minutesLabel, ScrollRow, SectionTitle, titleAction } from '../components/ui.tsx';
import type { Task, TimeOfDay } from '../lib/api.ts';
import { dayLabel, firstName, todayIso } from '../lib/dates.ts';
import { unfold } from '../lib/morph.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions, type TaskPatch } from '../lib/mutations.ts';
import { useGroups, useMe, useMembers, useTask, useTaskActivity, useTaskGap } from '../lib/queries.ts';

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div data-unfold className="flex items-start gap-4 py-3">
      <span className="mt-1.5 text-on-surface-variant">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-on-surface-variant">{label}</p>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  );
}

// A step or link coming and going, as a list's items do (ListPage's ItemRow). Each list's rows
// move only when one comes or goes (layoutDependency), not when the page around them changes.
const ROW_MOTION = {
  layout: 'position',
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, x: 48, transition: { duration: 0.18 } },
  transition: expressive.defaultSpatial,
} as const;

function ChipRow({ children }: { children: ReactNode }) {
  return <ScrollRow className="-mr-4 -my-2 flex gap-2 overflow-x-auto pt-2 pr-4 pb-3">{children}</ScrollRow>;
}

/** Saves free text when the field loses focus, so typing never waits on the network. */
function useDraft(value: string, save: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return { value: draft, onChange: (v: string) => setDraft(v), onBlur: () => draft !== value && save(draft) };
}

function Detail({ task }: { task: Task }) {
  const me = useMe();
  const navigate = useNavigate();
  const router = useRouter();
  const { data: groups } = useGroups();
  const { data: household } = useMembers();
  const actions = useTaskActions();
  const today = todayIso();
  const [moving, setMoving] = useState(false);
  const [repeating, setRepeating] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [handOff, setHandOff] = useState<{ id: string | null; note: string } | null>(null);
  const [newSubtask, setNewSubtask] = useState('');
  const [newLink, setNewLink] = useState('');

  const patch = (p: TaskPatch) => actions.update(task.id, p);
  const title = useDraft(task.title, (v) => v.trim() && patch({ title: v.trim() }));
  const notes = useDraft(task.notes ?? '', (v) => patch({ notes: v.trim() || null }));
  const back = () => (window.history.length > 1 ? router.history.back() : void navigate({ to: '/' }));
  const others = household?.members.filter((m) => m.id !== me?.id) ?? [];
  const done = task.status === 'done';
  // Only what's set on the task shows; everything else waits behind More details, opened task by
  // task. Something cleared while the page is open stays until it's left, rather than vanishing
  // under the finger that cleared it.
  const [more, setMore] = useState(false);
  const kept = useRef(new Set<keyof typeof filled>());
  const filled = {
    day: task.plannedDate !== null,
    time: task.timeOfDay !== null,
    due: task.dueDate !== null,
    reminder: task.reminder !== null,
    repeat: task.repeat !== null,
    group: task.groupId !== null,
    person: task.assigneeId !== me?.id,
    size: task.estimateSource === 'user' && task.estimateMinutes !== null,
    priority: task.mustDo,
    notes: !!task.notes,
    steps: task.subtasks.length > 0,
    links: task.links.length > 0,
    files: task.files.length > 0,
  };
  for (const part of Object.keys(filled) as (keyof typeof filled)[]) if (filled[part]) kept.current.add(part);
  const shows = (part: keyof typeof filled) => more || kept.current.has(part);
  const tucked = (
    [
      ['day', 'day'],
      ['time', 'time of day'],
      ['due', 'due date'],
      ['reminder', 'reminder'],
      ['repeat', 'repeat'],
      ['group', 'group'],
      ['size', 'how long'],
      ['priority', 'must do'],
      ['notes', 'notes'],
      ['steps', 'steps'],
      ['links', 'links'],
      ['files', 'files'],
    ] as [keyof typeof filled, string][]
  )
    .filter(([part]) => !kept.current.has(part))
    .map(([, words]) => words);
  // Loaded with the page, so History is there the moment More details opens.
  useTaskActivity(task.id);
  // Due later and not on a day yet: the day with the most room before the deadline.
  const wantsDay = task.status === 'open' && !task.plannedDate && !!task.dueDate && task.dueDate >= today;
  const { data: gap } = useTaskGap(task.id, wantsDay);

  return (
    <>
      <header className="mb-4 flex items-center justify-between">
        <BackButton onClick={back} />
        <button
          type="button"
          onClick={() => {
            actions.archive(task);
            back();
          }}
          aria-label="Remove task"
          className="grid size-12 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high"
        >
          <Delete className="size-6" aria-hidden />
        </button>
      </header>

      {/* The title is a field to edit, so the page's heading is for screen readers. */}
      <h1 className="sr-only">{task.title}</h1>
      <div className="flex items-start gap-3">
        <div className="pt-2">
          <Checkbox checked={done} onChange={() => actions.complete(task)} label={done ? 'Mark not done' : 'Complete'} size={32} />
        </div>
        <textarea
          value={title.value}
          onChange={(e) => {
            // One line. A phone keyboard's Enter arrives as a typed line break, and means done;
            // pasted lines join up.
            const v = e.target.value;
            if (v.includes('\n') && (e.nativeEvent as InputEvent).inputType !== 'insertFromPaste') return e.currentTarget.blur();
            title.onChange(v.replace(/\s*\n+\s*/g, ' '));
          }}
          onBlur={title.onBlur}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
          rows={1}
          aria-label="Title"
          className={`display field-sizing-content min-h-12 flex-1 resize-none bg-transparent text-[1.75rem] leading-tight font-medium outline-none ${
            done ? 'text-on-surface-variant line-through' : ''
          }`}
        />
      </div>

      {task.createdById !== me?.id && task.createdByName && (
        <p className="mt-2 ml-11 text-sm text-primary">From {firstName(task.createdByName)}</p>
      )}
      {task.handedBackNote && <p className="mt-2 ml-11 rounded-2xl bg-surface-high px-4 py-2.5 text-on-surface-variant">"{task.handedBackNote}"</p>}
      {task.listId && <TripCard task={task} />}

      <AnimatePresence initial={false}>
        {wantsDay && gap && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={expressive.defaultSpatial}
            className="overflow-hidden"
          >
            <div className="mt-4 flex items-center gap-3 rounded-3xl bg-secondary-container py-3 pr-3 pl-4 text-on-secondary-container">
              <Sparkle className="size-5 shrink-0" aria-hidden />
              <p className="min-w-0 flex-1 text-sm">
                {gap.fits
                  ? `${dayLabel(gap.date, today, true).replace(/^./, (c) => c.toUpperCase())} has the most room before it's due.`
                  : `Every day before it's due is full. ${dayLabel(gap.date, today, true).replace(/^./, (c) => c.toUpperCase())} is the lightest.`}
              </p>
              <button
                type="button"
                onClick={() => actions.move(task, gap.date, today)}
                className="press h-10 shrink-0 rounded-full bg-primary px-4 text-sm font-medium text-on-primary"
              >
                Plan it
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Kept on the page with nothing in it, so opening More details grows it from nothing. */}
      <div data-unfold="box" className="mt-4 divide-y divide-outline-variant/40 rounded-[1.75rem] bg-surface-low px-4 empty:mt-0">
        {shows('day') && (
          <Field icon={<Event className="size-5" />} label="Planned for">
            <button type="button" onClick={() => setMoving(true)} className="rounded-full bg-surface-high px-4 py-2 text-sm font-medium">
              {task.plannedDate ? dayLabel(task.plannedDate, today, true).replace(/^./, (c) => c.toUpperCase()) : 'Someday (backlog)'}
            </button>
          </Field>
        )}

        {shows('time') && (
          <Field icon={<Schedule className="size-5" />} label="Time of day">
            <ChipRow>
              {(
                [
                  [null, 'Any time'],
                  ['morning', 'Morning'],
                  ['afternoon', 'Afternoon'],
                  ['evening', 'Evening'],
                ] as [TimeOfDay | null, string][]
              ).map(([t, label]) => (
                <Chip key={t ?? 'any'} selected={task.timeOfDay === t} onClick={() => patch({ timeOfDay: t })}>
                  {label}
                </Chip>
              ))}
            </ChipRow>
          </Field>
        )}

        {shows('due') && (
          <Field icon={<EventBusy className="size-5" />} label="Due">
            <div className="flex items-center gap-2">
              <label className="relative cursor-pointer rounded-full bg-surface-high px-4 py-2 text-sm font-medium">
                {task.dueDate ? dayLabel(task.dueDate, today, true).replace(/^./, (c) => c.toUpperCase()) : 'No deadline'}
                <input
                  type="date"
                  value={task.dueDate ?? ''}
                  onChange={(e) => patch({ dueDate: e.target.value || null })}
                  onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
                  className="absolute inset-0 opacity-0"
                  aria-label="Due date"
                />
              </label>
              {task.dueDate && (
                <button type="button" onClick={() => patch({ dueDate: null })} aria-label="Clear due date" className="grid size-9 place-items-center rounded-full hover:bg-surface-high">
                  <Close className="size-5" aria-hidden />
                </button>
              )}
            </div>
          </Field>
        )}

        {shows('reminder') && (
          <Field icon={<Bell className="size-5" />} label="Remind me">
            <ReminderField task={task} onMore={() => setReminding(true)} />
          </Field>
        )}

        {shows('repeat') && (
          <Field icon={<RepeatIcon className="size-5" />} label="Repeats">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setRepeating(true)} className="rounded-full bg-surface-high px-4 py-2 text-sm font-medium">
                {task.repeat ? describeRepeat(task.repeat, repeatOn(task.repeat) === 'due' ? task.dueDate : task.plannedDate) : "Doesn't repeat"}
              </button>
              {task.repeat && task.status === 'open' && (
                <>
                  <button type="button" onClick={() => actions.skip(task)} className="rounded-full px-3 py-2 text-sm font-medium text-primary hover:bg-surface-high">
                    Skip next
                  </button>
                  {task.pausedUntil && task.pausedUntil > today ? (
                    <Chip selected onClick={() => patch({ pausedUntil: null })} icon={<Close />}>
                      Paused until {dayLabel(task.pausedUntil, today, true)}
                    </Chip>
                  ) : (
                    <label className="relative cursor-pointer rounded-full px-3 py-2 text-sm font-medium text-primary hover:bg-surface-high">
                      Pause
                      <input
                        type="date"
                        min={today}
                        onChange={(e) => e.target.value && patch({ pausedUntil: e.target.value })}
                        onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
                        className="absolute inset-0 opacity-0"
                        aria-label="Pause until"
                      />
                    </label>
                  )}
                </>
              )}
            </div>
          </Field>
        )}

        {shows('group') && (
          <Field icon={<Folder className="size-5" />} label="Group">
            <ChipRow>
              <Chip selected={task.groupId === null} onClick={() => patch({ groupId: null })}>
                None
              </Chip>
              {groups
                ?.filter((g) => g.kind === 'tasks')
                .map((g) => (
                  <Chip key={g.id} selected={task.groupId === g.id} onClick={() => patch({ groupId: g.id })} icon={<GroupIcon name={g.icon} className="size-4" />}>
                    {g.name}
                  </Chip>
                ))}
            </ChipRow>
          </Field>
        )}

        {(others.length > 0 || task.assigneeId !== me?.id) && shows('person') && (
          <Field icon={<Person className="size-5" />} label="For">
            <ChipRow>
              <Chip selected={task.assigneeId === me?.id} onClick={() => actions.assign(task.id, me!.id)}>
                Me
              </Chip>
              {others.map((o) => (
                <Chip key={o.id} selected={task.assigneeId === o.id} onClick={() => setHandOff({ id: o.id, note: '' })}>
                  {firstName(o.name)}
                </Chip>
              ))}
              <Chip selected={task.assigneeId === null} onClick={() => actions.assign(task.id, null)}>
                Anyone
              </Chip>
            </ChipRow>
            <AnimatePresence>
              {handOff && (
                <motion.form
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={expressive.defaultSpatial}
                  className="overflow-hidden"
                  onSubmit={(e) => {
                    e.preventDefault();
                    actions.assign(task.id, handOff.id, handOff.note.trim() || null);
                    setHandOff(null);
                  }}
                >
                  <input
                    value={handOff.note}
                    onChange={(e) => setHandOff({ ...handOff, note: e.target.value })}
                    placeholder="Add a note (optional)"
                    aria-label="Note"
                    className="mt-3 w-full rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setHandOff(null)} className="rounded-full px-4 py-2 text-sm font-medium">
                      Cancel
                    </button>
                    <button type="submit" className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary">
                      Hand it over
                    </button>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>
          </Field>
        )}

        {shows('size') && (
          <Field icon={<Timer className="size-5" />} label={task.estimateSource === 'ai' && task.estimateMinutes ? "Takes about (Amble's guess)" : 'Takes about'}>
            <ChipRow>
              {[null, 5, 15, 30, 60, 120, ...(task.estimateMinutes && ![5, 15, 30, 60, 120].includes(task.estimateMinutes) ? [task.estimateMinutes] : [])]
                .sort((a, b) => (a ?? 0) - (b ?? 0))
                .map((m) => (
                <Chip key={m ?? 'none'} selected={task.estimateMinutes === m} onClick={() => patch({ estimateMinutes: m })}>
                  {m ? minutesLabel(m) : 'Not sure'}
                </Chip>
              ))}
            </ChipRow>
          </Field>
        )}

        {shows('priority') && (
          <Field icon={<Flag className="size-5" />} label="Priority">
            <Chip selected={task.mustDo} onClick={() => patch({ mustDo: !task.mustDo })}>
              Must do
            </Chip>
          </Field>
        )}
      </div>

      {tucked.length > 0 && (
        <button
          type="button"
          onClick={() => unfold(() => flushSync(() => setMore(!more)))}
          aria-expanded={more}
          data-unfold
          className="mt-2 flex w-full items-center gap-3 rounded-full px-4 py-3 text-left text-sm text-on-surface-variant"
        >
          <span className="min-w-0 flex-1">
            <span className="font-medium text-primary">{more ? 'Fewer details' : 'More details'}</span>
            {!more && <span className="block truncate">{tucked.join(', ').replace(/^./, (c) => c.toUpperCase())}</span>}
          </span>
          <ExpandMore className={`size-6 shrink-0 text-primary transition-transform ${more ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      )}

      {shows('notes') && (
        <div data-unfold>
          <SectionTitle>Notes</SectionTitle>
          <textarea
            value={notes.value}
            onChange={(e) => notes.onChange(e.target.value)}
            onBlur={notes.onBlur}
            placeholder="Anything worth remembering"
            aria-label="Notes"
            className="field-sizing-content min-h-24 w-full resize-none rounded-[1.75rem] bg-surface-low px-5 py-4 outline-none placeholder:text-on-surface-variant"
          />
        </div>
      )}

      {shows('steps') && (
        <div data-unfold>
          <SectionTitle>Steps</SectionTitle>
          <ul className="flex flex-col gap-1 rounded-[1.75rem] bg-surface-low p-2">
            <AnimatePresence initial={false}>
              {task.subtasks.map((s) => (
                <motion.li key={s.id} {...ROW_MOTION} layoutDependency={task.subtasks.length} className="flex items-center gap-3 rounded-2xl px-2 py-2">
                  <Checkbox
                    checked={s.done}
                    size={24}
                    label={s.title}
                    onChange={() => patch(s.done ? { uncheckSubtasks: [s.id] } : { checkSubtasks: [s.id] })}
                  />
                  <span className={`flex-1 ${s.done ? 'text-on-surface-variant line-through' : ''}`}>{s.title}</span>
                  <button type="button" onClick={() => patch({ removeSubtasks: [s.id] })} aria-label={`Remove ${s.title}`} className="grid size-9 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
                    <Close className="size-5" aria-hidden />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
            <motion.li layout="position" layoutDependency={task.subtasks.length} transition={expressive.defaultSpatial}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newSubtask.trim()) patch({ addSubtasks: [newSubtask.trim()] });
                  setNewSubtask('');
                }}
              >
                <input
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  placeholder="Add a step"
                  aria-label="Add a step"
                  className="w-full rounded-2xl bg-transparent px-3 py-2.5 outline-none placeholder:text-on-surface-variant"
                />
              </form>
            </motion.li>
          </ul>
        </div>
      )}

      {shows('links') && (
        <div data-unfold>
          <SectionTitle>Links</SectionTitle>
          <ul className="flex flex-col gap-1 rounded-[1.75rem] bg-surface-low p-2">
            <AnimatePresence initial={false}>
              {task.links.map((l) => (
                <motion.li key={l.id} {...ROW_MOTION} layoutDependency={task.links.length} className="flex items-center gap-1 rounded-2xl">
                  {/* The icon and title are one link, a row tall enough to tap, tinting round when pressed. */}
                  <a href={l.url} target="_blank" rel="noreferrer noopener" className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-2xl px-2 text-primary">
                    <LinkIcon className="size-5 shrink-0 text-on-surface-variant" aria-hidden />
                    <span className="truncate">{l.title ?? l.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
                  </a>
                  <a href={l.url} target="_blank" rel="noreferrer noopener" aria-label="Open" className="tap grid size-9 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
                    <OpenInNew className="size-5" aria-hidden />
                  </a>
                  <button type="button" onClick={() => patch({ removeLinks: [l.id] })} aria-label="Remove link" className="grid size-9 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
                    <Close className="size-5" aria-hidden />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
            <motion.li layout="position" layoutDependency={task.links.length} transition={expressive.defaultSpatial}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const url = newLink.trim();
                  if (url) patch({ addLinks: [{ url: /^https?:\/\//i.test(url) ? url : `https://${url}` }] });
                  setNewLink('');
                }}
              >
                <input
                  value={newLink}
                  onChange={(e) => setNewLink(e.target.value)}
                  placeholder="Paste a link"
                  aria-label="Add a link"
                  inputMode="url"
                  className="w-full rounded-2xl bg-transparent px-3 py-2.5 outline-none placeholder:text-on-surface-variant"
                />
              </form>
            </motion.li>
          </ul>
        </div>
      )}

      {shows('files') && (
        <div data-unfold>
          <SectionTitle>Files</SectionTitle>
          <TaskFiles task={task} />
        </div>
      )}

      {more && (
        <div data-unfold>
          <History task={task} />
        </div>
      )}

      <ReminderSheet task={task} open={reminding} onClose={() => setReminding(false)} />
      <MoveSheet task={moving ? task : null} today={today} onClose={() => setMoving(false)} />
      <RepeatSheet
        open={repeating}
        onClose={() => setRepeating(false)}
        value={task.repeat}
        date={(task.repeat && repeatOn(task.repeat) === 'due' ? task.dueDate : task.plannedDate) ?? task.dueDate ?? task.plannedDate ?? today}
        onSave={(repeat) => patch({ repeat })}
      />
    </>
  );
}

const HISTORY_PREVIEW = 4;

/** Who did what to this task, newest first. */
function History({ task }: { task: Task }) {
  const me = useMe();
  const { data: household } = useMembers();
  const { data: entries } = useTaskActivity(task.id);
  const [all, setAll] = useState(false);
  if (!entries?.length) {
    return (
      <p className="mt-6 px-1 text-sm text-on-surface-variant">
        Added {task.createdByName ? `by ${firstName(task.createdByName)} ` : ''}
        {new Date(task.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
      </p>
    );
  }
  const shown = all ? entries : entries.slice(0, HISTORY_PREVIEW);
  const ctx = { meId: me?.id ?? '', members: household?.members ?? [], today: todayIso(), inTask: true };
  return (
    <>
      <SectionTitle
        action={
          entries.length > HISTORY_PREVIEW && (
            <button type="button" onClick={() => unfold(() => flushSync(() => setAll((v) => !v)))} className={titleAction}>
              {all ? 'Show less' : `Show all ${entries.length}`}
            </button>
          )
        }
      >
        History
      </SectionTitle>
      <ul data-unfold="box" className="rounded-[1.75rem] bg-surface-low px-4 py-1">
        {shown.map((e) => (
          <ActivityRow key={e.id} entry={e} ctx={ctx} showTime={false} />
        ))}
      </ul>
    </>
  );
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const { data: task, error } = useTask(taskId);
  if (error) return <p className="mt-10 text-center text-on-surface-variant">That task isn't here anymore.</p>;
  if (!task) return <div className="h-40" />;
  return <Detail task={task} />;
}

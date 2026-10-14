import { useNavigate, useRouter } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import Close from '~icons/material-symbols/close-rounded';
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
import { describeRepeat, repeatOn } from '../../../shared/repeat.ts';
import { Checkbox, Chip, minutesLabel, SectionTitle } from '../components/ui.tsx';
import type { Task, TimeOfDay } from '../lib/api.ts';
import { dayLabel, firstName, todayIso } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions, type TaskPatch } from '../lib/mutations.ts';
import { useGroups, useMe, useMembers, useTask, useTaskActivity, useTaskGap } from '../lib/queries.ts';
import { useSyncState } from '../lib/sync.ts';

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-3">
      <span className="mt-1.5 text-on-surface-variant">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-on-surface-variant">{label}</p>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  );
}

function ChipRow({ children }: { children: ReactNode }) {
  return <div className="-mr-4 flex gap-2 overflow-x-auto pr-4 pb-1">{children}</div>;
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
  const { online } = useSyncState();
  // Due later and not on a day yet: the day with the most room before the deadline.
  const wantsDay = task.status === 'open' && !task.plannedDate && !!task.dueDate && task.dueDate >= today;
  const { data: gap } = useTaskGap(task.id, wantsDay && online);

  return (
    <>
      <header className="mb-4 flex items-center justify-between">
        <button type="button" onClick={back} aria-label="Back" className="-ml-2 grid size-12 place-items-center rounded-full hover:bg-surface-high">
          <ArrowBack className="size-6" aria-hidden />
        </button>
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

      <div className="flex items-start gap-3">
        <div className="pt-2">
          <Checkbox checked={done} onChange={() => actions.complete(task)} label={done ? 'Mark not done' : 'Complete'} size={32} />
        </div>
        <textarea
          value={title.value}
          onChange={(e) => title.onChange(e.target.value)}
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

      <div className="mt-4 divide-y divide-outline-variant/40 rounded-[1.75rem] bg-surface-low px-4">
        <Field icon={<Event className="size-5" />} label="Planned for">
          <button type="button" onClick={() => setMoving(true)} className="rounded-full bg-surface-high px-4 py-2 text-sm font-medium">
            {task.plannedDate ? dayLabel(task.plannedDate, today, true).replace(/^./, (c) => c.toUpperCase()) : 'Someday (backlog)'}
          </button>
        </Field>

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

        <Field icon={<Bell className="size-5" />} label="Remind me">
          <ReminderField task={task} onMore={() => setReminding(true)} />
        </Field>

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
                  <Chip selected onClick={() => patch({ pausedUntil: null })} icon={<Close className="size-4" />}>
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

        {(others.length > 0 || task.assigneeId !== me?.id) && (
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

        <Field icon={<Timer className="size-5" />} label={task.estimateSource === 'ai' && task.estimateMinutes ? "Takes about (Haiku's guess)" : 'Takes about'}>
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

        <Field icon={<Flag className="size-5" />} label="Priority">
          <Chip selected={task.mustDo} onClick={() => patch({ mustDo: !task.mustDo })}>
            Must do
          </Chip>
        </Field>
      </div>

      <SectionTitle>Notes</SectionTitle>
      <textarea
        value={notes.value}
        onChange={(e) => notes.onChange(e.target.value)}
        onBlur={notes.onBlur}
        placeholder="Anything worth remembering"
        aria-label="Notes"
        className="field-sizing-content min-h-24 w-full resize-none rounded-[1.75rem] bg-surface-low px-5 py-4 outline-none placeholder:text-on-surface-variant"
      />

      <SectionTitle>Steps</SectionTitle>
      <ul className="flex flex-col gap-1 rounded-[1.75rem] bg-surface-low p-2">
        {task.subtasks.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-2xl px-2 py-2">
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
          </li>
        ))}
        <li>
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
        </li>
      </ul>

      <SectionTitle>Links</SectionTitle>
      <ul className="flex flex-col gap-1 rounded-[1.75rem] bg-surface-low p-2">
        {task.links.map((l) => (
          <li key={l.id} className="flex items-center gap-3 rounded-2xl px-2 py-1">
            <LinkIcon className="size-5 shrink-0 text-on-surface-variant" aria-hidden />
            <a href={l.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate py-2 text-primary">
              {l.title ?? l.url.replace(/^https?:\/\/(www\.)?/, '')}
            </a>
            <a href={l.url} target="_blank" rel="noreferrer noopener" aria-label="Open" className="grid size-9 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
              <OpenInNew className="size-5" aria-hidden />
            </a>
            <button type="button" onClick={() => patch({ removeLinks: [l.id] })} aria-label="Remove link" className="grid size-9 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
              <Close className="size-5" aria-hidden />
            </button>
          </li>
        ))}
        <li>
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
        </li>
      </ul>

      <SectionTitle>Files</SectionTitle>
      <TaskFiles task={task} />

      <History task={task} />

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
            <button type="button" onClick={() => setAll((v) => !v)} className="rounded-full px-3 py-1 text-sm font-medium text-primary hover:bg-surface-high">
              {all ? 'Show less' : `Show all ${entries.length}`}
            </button>
          )
        }
      >
        History
      </SectionTitle>
      <ul className="rounded-[1.75rem] bg-surface-low px-4 py-1">
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

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import Event from '~icons/material-symbols/event-outline-rounded';
import Flag from '~icons/material-symbols/flag-rounded';
import type { TimeOfDay } from '../lib/api.ts';
import { addDays, dayLabel, firstName, todayIso } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useGroups, useMe, useMembers } from '../lib/queries.ts';
import { GroupIcon } from './icons.tsx';
import { Chip, Sheet } from './ui.tsx';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="mb-1.5 px-1 text-xs text-on-surface-variant">{label}</p>
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">{children}</div>
    </div>
  );
}

function DateChip({ value, label, onPick }: { value: string | null; label: string; onPick: (d: string | null) => void }) {
  return (
    <label
      className={`relative flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full pr-3.5 pl-2.5 text-sm ${
        value ? 'bg-secondary-container text-on-secondary-container' : 'border border-outline-variant text-on-surface-variant'
      }`}
    >
      <Event className="size-4" aria-hidden />
      {label}
      <input
        type="date"
        min={todayIso()}
        value={value ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
        onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
        className="absolute inset-0 opacity-0"
        aria-label={label}
      />
    </label>
  );
}

/** Quick add from the + button. Stays open for adding several in a row. */
export function AddSheet({ open, onClose, plannedByDefault }: { open: boolean; onClose: () => void; plannedByDefault: boolean }) {
  const me = useMe();
  const { data: groups } = useGroups();
  const { data: household } = useMembers();
  const actions = useTaskActions();
  const input = useRef<HTMLInputElement>(null);
  const today = todayIso();

  const [title, setTitle] = useState('');
  const [planned, setPlanned] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null | undefined>(undefined);
  const [time, setTime] = useState<TimeOfDay | null>(null);
  const [mustDo, setMustDo] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setPlanned(plannedByDefault ? today : null);
    setAdded([]);
    setTimeout(() => input.current?.focus(), 250);
  }, [open, plannedByDefault, today]);

  const others = household?.members.filter((m) => m.id !== me?.id) ?? [];
  const taskGroups = groups?.filter((g) => g.kind === 'tasks') ?? [];

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    actions.create.mutate(
      { title: t, plannedDate: planned, dueDate: due, groupId, assigneeId: assignee, timeOfDay: time, mustDo },
      { onSuccess: () => setAdded((a) => [t, ...a]) },
    );
    setTitle('');
    setMustDo(false);
    input.current?.focus();
  };

  return (
    <Sheet open={open} onClose={onClose} label="Add a task">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            ref={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            aria-label="Task"
            enterKeyHint="done"
            className="min-w-0 flex-1 rounded-2xl bg-surface-high px-4 py-3.5 text-lg outline-none placeholder:text-on-surface-variant"
          />
          <motion.button
            type="submit"
            whileTap={{ scale: 0.92 }}
            transition={expressive.fastSpatial}
            disabled={!title.trim()}
            className="h-14 rounded-2xl bg-primary px-5 font-medium text-on-primary disabled:opacity-40"
          >
            Add
          </motion.button>
        </div>

        <Row label="When">
          <Chip selected={planned === null} onClick={() => setPlanned(null)}>
            Someday
          </Chip>
          <Chip selected={planned === today} onClick={() => setPlanned(today)}>
            Today
          </Chip>
          <Chip selected={planned === addDays(today, 1)} onClick={() => setPlanned(addDays(today, 1))}>
            Tomorrow
          </Chip>
          <DateChip
            value={planned && planned > addDays(today, 1) ? planned : null}
            label={planned && planned > addDays(today, 1) ? dayLabel(planned, today) : 'Pick a day'}
            onPick={setPlanned}
          />
        </Row>

        <Row label="Group">
          <Chip selected={groupId === null} onClick={() => setGroupId(null)}>
            None
          </Chip>
          {taskGroups.map((g) => (
            <Chip key={g.id} selected={groupId === g.id} onClick={() => setGroupId(g.id)} icon={<GroupIcon name={g.icon} className="size-4" />}>
              {g.name}
            </Chip>
          ))}
        </Row>

        {others.length > 0 && (
          <Row label="For">
            <Chip selected={assignee === undefined} onClick={() => setAssignee(undefined)}>
              Me
            </Chip>
            {others.map((o) => (
              <Chip key={o.id} selected={assignee === o.id} onClick={() => setAssignee(o.id)}>
                {firstName(o.name)}
              </Chip>
            ))}
            <Chip selected={assignee === null} onClick={() => setAssignee(null)}>
              Anyone
            </Chip>
          </Row>
        )}

        <Row label="More">
          {(['morning', 'afternoon', 'evening'] as const).map((t) => (
            <Chip key={t} selected={time === t} onClick={() => setTime(time === t ? null : t)}>
              <span className="capitalize">{t}</span>
            </Chip>
          ))}
          <Chip selected={mustDo} onClick={() => setMustDo((v) => !v)} icon={<Flag className="size-4" />}>
            Must do
          </Chip>
          <DateChip value={due} label={due ? `Due ${dayLabel(due, today, true)}` : 'Due date'} onPick={setDue} />
        </Row>

        <AnimatePresence>
          {added.length > 0 && (
            <motion.p
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={expressive.fastSpatial}
              className="mt-4 px-1 text-sm text-on-surface-variant"
            >
              Added {added.length === 1 ? `"${added[0]}"` : `${added.length} tasks`}.
            </motion.p>
          )}
        </AnimatePresence>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-full bg-surface-high py-3.5 font-medium">
          Done
        </button>
      </form>
    </Sheet>
  );
}

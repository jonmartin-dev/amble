import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Close from '~icons/material-symbols/close-rounded';
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import type { Task } from '../lib/api.ts';
import { addDays, dayLabel, isoDate, reminderLabel, reminderPhrase, todayIso } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { native } from '../lib/native.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { enablePush, usePushState, type PushState } from '../lib/push.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { Chip, Sheet } from './ui.tsx';

export interface ReminderChoice {
  label: string;
  at: Date;
}

/** A local date and clock time as a moment on this device. */
const at = (date: string, time: string) => new Date(`${date}T${time}`);

/** Quick times that fit the moment and the task: soon, this evening, tomorrow, its day. */
export function reminderChoices(task: Pick<Task, 'plannedDate' | 'dueDate'>, now = new Date()): ReminderChoice[] {
  const today = isoDate(now);
  const tomorrow = addDays(today, 1);
  const out: ReminderChoice[] = [];
  const inAnHour = new Date(Math.ceil((now.getTime() + 60 * 60_000) / (5 * 60_000)) * 5 * 60_000);
  out.push({ label: 'In an hour', at: inAnHour });
  if (now.getHours() < 17) out.push({ label: 'This evening', at: at(today, '18:00') });
  out.push({ label: 'Tomorrow morning', at: at(tomorrow, '09:00') });
  const planned = task.plannedDate;
  if (planned && planned > tomorrow) out.push({ label: `${dayLabel(planned, todayIso(), true).replace(/^./, (c) => c.toUpperCase())} morning`, at: at(planned, '09:00') });
  const due = task.dueDate;
  if (due && addDays(due, -1) > today && addDays(due, -1) !== planned) out.push({ label: 'The evening before it’s due', at: at(addDays(due, -1), '18:00') });
  return out;
}

/** What the reminder hint says when this device won't show it. */
export function pushHint(state: PushState | null) {
  switch (state) {
    case 'off':
      return 'Notifications are off on this device.';
    case 'blocked':
      return native
        ? "Notifications are off for Amble in Android's settings, so reminders can't show here."
        : "Notifications are blocked for Amble in this browser's site settings, so reminders can't show here.";
    case 'needs-install':
      return 'Add Amble to your home screen (Share, then Add to Home Screen) to get reminders on this device.';
    case 'unsupported':
      return "This browser can't show reminders. They'll go to your other devices.";
    default:
      return null;
  }
}

/**
 * Sets a reminder, and the first time, turns notifications on for this device. The browser asks
 * for permission then, so it's tied to the tap that set the reminder.
 */
export function useSetReminder() {
  const actions = useTaskActions();
  const snack = useSnackbar();
  const push = usePushState();
  const set = (task: Task, when: Date | null) => {
    if (when && when.getTime() < Date.now() - 60_000) {
      snack({ message: 'That time has already passed. Pick a later one.' });
      return;
    }
    actions.remind(task, when);
    if (when && push.state === 'off') {
      enablePush()
        .catch((e: Error) => snack({ message: e.message }))
        .finally(() => void push.check());
    }
  };
  return { set, push };
}

/** Pick when to be reminded about a task: a quick time, or any day and time. */
export function ReminderSheet({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  const { set } = useSetReminder();
  const now = new Date();
  const pending = task.reminder && !task.reminder.sentAt ? task.reminder : null;
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  // Each time it opens: the reminder's own time, or the task's day (else today) at a sensible hour.
  useEffect(() => {
    if (!open) return;
    const today = isoDate(new Date());
    setDate(pending ? isoDate(new Date(pending.at)) : task.plannedDate && task.plannedDate > today ? task.plannedDate : today);
    setTime(pending ? new Date(pending.at).toTimeString().slice(0, 5) : new Date().getHours() < 17 ? '18:00' : '09:00');
  }, [open]);
  const custom = at(date, time);
  const valid = !Number.isNaN(custom.getTime()) && custom.getTime() > Date.now();

  const pick = (when: Date | null) => {
    set(task, when);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label="Remind me"
      footer={
        <div className="flex items-center justify-between gap-2 pb-1">
          {pending ? (
            <button type="button" onClick={() => pick(null)} className="rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high">
              Remove reminder
            </button>
          ) : (
            <span />
          )}
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            disabled={!valid}
            onClick={() => pick(custom)}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary transition-opacity disabled:opacity-40"
          >
            Set reminder
          </motion.button>
        </div>
      }
    >
      <p className="text-sm text-on-surface-variant">Remind me about</p>
      <p className="display mt-0.5 text-2xl leading-tight font-medium">{task.title}</p>

      <ul className="mt-5 flex flex-col gap-1">
        {reminderChoices(task, now).map((c, i) => (
          <motion.li key={c.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...expressive.fastSpatial, delay: i * 0.03 }}>
            <button type="button" onClick={() => pick(c.at)} className="flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-surface-high">
              <Bell className="size-5 shrink-0 text-on-surface-variant" aria-hidden />
              <span className="flex-1">{c.label}</span>
              <span className="text-sm text-on-surface-variant">{reminderLabel(c.at)}</span>
            </button>
          </motion.li>
        ))}
      </ul>

      <p className="mt-5 px-1 text-sm font-medium text-primary">Another time{valid ? `: ${reminderPhrase(custom)}` : ''}</p>
      <div className="mt-2 flex gap-2">
        <input
          type="date"
          value={date}
          min={isoDate(now)}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          aria-label="Reminder date"
          className="min-w-0 flex-1 rounded-2xl bg-surface-high px-4 py-3 outline-none"
        />
        <input
          type="time"
          value={time}
          onChange={(e) => e.target.value && setTime(e.target.value)}
          aria-label="Reminder time"
          className="w-40 rounded-2xl bg-surface-high px-4 py-3 outline-none"
        />
      </div>
    </Sheet>
  );
}

/** The reminder row on a task's page: quick times, or the reminder that's set and a way to clear it. */
export function ReminderField({ task, onMore }: { task: Task; onMore: () => void }) {
  const { set, push } = useSetReminder();
  const snack = useSnackbar();
  const pending = task.reminder && !task.reminder.sentAt ? task.reminder : null;
  const sent = task.reminder?.sentAt ? task.reminder : null;
  const hint = pending ? pushHint(push.state) : null;
  const turnOn = () =>
    enablePush()
      .catch((e: Error) => snack({ message: e.message }))
      .finally(() => void push.check());

  return (
    <>
      {pending ? (
        <div className="flex items-center gap-2">
          <button type="button" onClick={onMore} className="rounded-full bg-secondary-container px-4 py-2 text-sm font-medium text-on-secondary-container">
            {reminderLabel(pending.at)}
          </button>
          <button type="button" onClick={() => set(task, null)} aria-label="Clear reminder" className="grid size-9 place-items-center rounded-full hover:bg-surface-high">
            <Close className="size-5" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="-mr-4 flex gap-2 overflow-x-auto pr-4 pb-1">
          {reminderChoices(task)
            .slice(0, 2)
            .map((c) => (
              <Chip key={c.label} onClick={() => set(task, c.at)}>
                {c.label}
              </Chip>
            ))}
          <Chip onClick={onMore}>Other time</Chip>
        </div>
      )}
      {sent && <p className="mt-2 text-xs text-on-surface-variant">Reminded you {reminderPhrase(sent.at)}</p>}
      {hint && (
        <p className="mt-2 text-xs text-on-surface-variant">
          {hint}{' '}
          {push.state === 'off' && (
            <button type="button" onClick={() => void turnOn()} className="font-medium text-primary">
              Turn on
            </button>
          )}
        </p>
      )}
    </>
  );
}

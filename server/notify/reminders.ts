// Sends the reminders whose time has come. The scheduler runs it every minute.
import type { Db } from '../db/index.ts';
import type { Member, Task } from '../db/schema.ts';
import { dueReminders, markReminder } from '../domain/reminders.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import type { Push } from './push.ts';

// Past this, the moment has gone (the server was down at the time), so it isn't sent late.
const STALE_MS = 6 * 60 * 60 * 1000;
// Devices that couldn't be reached get another try each minute for this long.
const RETRY_FOR_MS = 30 * 60 * 1000;

export const SNOOZE_MINUTES = 60;

/**
 * The line under the task's title: its deadline if that's close, or the start of its notes. `at` is
 * when it shows, for a phone that schedules it ahead.
 */
export function reminderBody(task: Pick<Task, 'dueDate' | 'notes'>, member: Member, at = new Date()): string | undefined {
  const today = planningDate(member, Temporal.Instant.fromEpochMilliseconds(at.getTime()));
  if (task.dueDate === today) return 'Due today';
  if (task.dueDate === addDays(today, 1)) return 'Due tomorrow';
  const note = task.notes
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!note) return undefined;
  return note.length > 120 ? `${note.slice(0, 119)}…` : note;
}

export function createReminderSender(db: Db, push: Push, basePath: string) {
  return {
    /** Sends what's due; returns how many went out. */
    async run(now = new Date()) {
      let sent = 0;
      for (const { reminder, task, member } of dueReminders(db, now)) {
        const late = now.getTime() - reminder.fireAt.getTime();
        if (task.status !== 'open' || late > STALE_MS) {
          markReminder(db, reminder.id, 'skipped');
          continue;
        }
        const result = await push.sendTo(member.id, {
          title: task.title,
          body: reminderBody(task, member),
          tag: reminder.id,
          url: `${basePath}/task/${task.id}`,
          actions: [
            { action: 'done', title: 'Done' },
            { action: 'snooze', title: 'Snooze 1 hour' },
          ],
          data: { kind: 'reminder', reminderId: reminder.id, taskId: task.id, memberId: member.id, snoozeMinutes: SNOOZE_MINUTES, at: reminder.fireAt.getTime() },
        });
        if (result.sent > 0) {
          markReminder(db, reminder.id, 'sent');
          sent++;
        } else if (result.devices === result.gone) markReminder(db, reminder.id, 'no-device');
        else if (late > RETRY_FOR_MS) markReminder(db, reminder.id, 'failed');
      }
      return sent;
    },
  };
}

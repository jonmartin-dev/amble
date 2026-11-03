// What syncs between a household's devices: the household's data, field by field. Sign-ins,
// connector grants, calendars (each phone reads its own; only how busy each day is syncs), AI
// spending and push devices stay on the device or server that has them. The household's own AI
// model syncs, with what each device spent on it, so they share one monthly cap.

export interface SyncedTable {
  name: string;
  pk: string[];
  /** Columns that belong to this copy alone. */
  local?: string[];
}

// Parents before children, so rows go in an order their references can follow.
export const SYNCED: SyncedTable[] = [
  { name: 'members', pk: ['id'], local: ['last_login_at'] },
  { name: 'groups', pk: ['id'] },
  { name: 'series', pk: ['id'] },
  { name: 'tasks', pk: ['id'] },
  { name: 'subtasks', pk: ['id'] },
  { name: 'task_links', pk: ['id'] },
  { name: 'list_items', pk: ['id'] },
  { name: 'activity', pk: ['id'] },
  { name: 'attachments', pk: ['id'] },
  // Each device shows a reminder itself when there's no server, so whether it went out here is its own.
  { name: 'reminders', pk: ['id'], local: ['sent_at', 'outcome'] },
  { name: 'day_records', pk: ['member_id', 'date'] },
  { name: 'busy_days', pk: ['member_id', 'date'] },
  { name: 'household_settings', pk: ['key'] },
  { name: 'household_ai_spend', pk: ['site', 'month'] },
];

export const syncedTable = (name: string) => SYNCED.find((t) => t.name === name);

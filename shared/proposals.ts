// What smart add proposes from what someone typed. Nothing is saved until the person accepts;
// the app shows these for review and sends back the ones they keep, edited or not.
import type { Repeat } from './repeat.ts';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface ProposedTask {
  title: string;
  notes: string | null;
  groupId: string | null;
  /** A member id, or null for anyone in the household. */
  assigneeId: string | null;
  plannedDate: string | null;
  dueDate: string | null;
  timeOfDay: TimeOfDay | null;
  mustDo: boolean;
  estimateMinutes: number | null;
  /** "ai" while the estimate is Haiku's; the app switches it to "user" when someone changes it. */
  estimateSource: 'ai' | 'user';
  subtasks: string[];
  links: string[];
  repeat: Repeat | null;
}

export interface TaskChanges {
  title?: string;
  notes?: string | null;
  groupId?: string | null;
  assigneeId?: string | null;
  plannedDate?: string | null;
  dueDate?: string | null;
  timeOfDay?: TimeOfDay | null;
  mustDo?: boolean;
  estimateMinutes?: number | null;
  addSubtasks?: string[];
  repeat?: Repeat | null;
}

export type Proposal =
  | { kind: 'task'; task: ProposedTask }
  | { kind: 'list_item'; listId: string; name: string; quantity: string | null; section: string | null; note: string | null }
  | { kind: 'update'; taskId: string; title: string; changes: TaskChanges }
  | { kind: 'complete'; taskId: string; title: string }
  | { kind: 'check'; listId: string; itemId: string; name: string };

/** What was already picked in the add sheet. `explicit` ones were tapped; the rest are the screen's defaults. */
export interface AddHints {
  plannedDate?: string | null;
  dueDate?: string | null;
  groupId?: string | null;
  assigneeId?: string | null;
  timeOfDay?: TimeOfDay | null;
  mustDo?: boolean;
  explicit?: ('plannedDate' | 'dueDate' | 'groupId' | 'assigneeId' | 'timeOfDay' | 'mustDo')[];
}

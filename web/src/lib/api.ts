import type { AiEffort, AiProviderId } from '../../../shared/ai.ts';
import type { Proposal } from '../../../shared/proposals.ts';
import type { Repeat } from '../../../shared/repeat.ts';
import { basePath, deviceFetch } from './device.ts';
import type { ThemePrefs } from './theme.ts';

export type { Repeat, Proposal };
export { basePath };

/** The Amble server this app was served from, if it was: the household can sync with it. */
export const servedBy = window.__AMBLE__?.server ?? null;

export const appUrl = (path: string) => `${basePath}${path}`;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Status 0: the request never reached the server. */
export const OFFLINE_MESSAGE = "You're offline, so that didn't go through. Try again once you're connected.";

/** fetch() for a path under /api: the API running on this device. */
export function send(path: string, init?: RequestInit): Promise<Response> {
  return deviceFetch(path, init);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await send(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  role: 'admin' | 'member';
  theme: Partial<ThemePrefs> | null;
  /** Task minutes per ISO weekday ("1" is Monday); missing days use the default. */
  capacity: Partial<Record<string, number>> | null;
  showStreaks: boolean;
  smartAdd: boolean;
}

export interface Session {
  member: Member | null;
  auth: {
    provider: string;
    oidc: boolean;
    devEmails: string[];
    privacyContact: string;
    ai: { provider: AiProviderId; name: string } | null;
    /** `device`: Amble runs on this device, with no server and no sign-in. */
    mode?: 'device';
  };
}

export interface Group {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: 'tasks' | 'list';
  template: string | null;
  /** A list's own sections, when someone changed its template's. */
  sections: string[] | null;
  privateTo: string | null;
  /** Open tasks, or unchecked items for a list. */
  open: number;
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  groupId: string | null;
  groupName: string | null;
  /** The list this task is a trip for, like Groceries for a grocery run. */
  listId: string | null;
  listName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  createdById: string | null;
  createdByName: string | null;
  dueDate: string | null;
  plannedDate: string | null;
  timeOfDay: TimeOfDay | null;
  mustDo: boolean;
  estimateMinutes: number | null;
  estimateSource: 'ai' | 'user' | 'learned' | null;
  /** The model's guess, kept after someone changes it. */
  aiEstimateMinutes?: number | null;
  status: 'open' | 'done' | 'archived';
  completedAt: string | null;
  handedBackNote: string | null;
  createdAt: string;
  updatedAt: string;
  subtasks: { id: string; title: string; done: boolean }[];
  links: { id: string; url: string; title: string | null }[];
  repeat: Repeat | null;
  pausedUntil: string | null;
  /** Your own reminder about it, if you set one. */
  reminder: Reminder | null;
  files: TaskFile[];
  sortOrder?: number;
}

export interface Reminder {
  id: string;
  at: string;
  /** When it went out; null while it's still to come. */
  sentAt: string | null;
}

export interface TaskFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** A smaller copy of a photo exists. */
  preview: boolean;
  addedById: string | null;
  createdAt: string;
}

export interface PushDevice {
  id: string;
  endpoint: string;
  device: string | null;
  createdAt: string;
  lastSentAt: string | null;
}

export interface UpcomingReminder {
  id: string;
  taskId: string;
  title: string;
  at: string;
  /** The line under the title in its notification. */
  body: string | null;
}

export interface DayLoad {
  date: string;
  weekday: string;
  tasks: number;
  mustDo: number;
  plannedMinutes: number;
  guessed: number;
  /** Room for tasks, after the calendar. */
  capacityMinutes: number;
  /** Room on an ordinary day like this one, before the calendar. */
  baseCapacityMinutes: number;
  /** Busy calendar time, 7am to 10pm, and how many busy events. */
  eventMinutes: number;
  events: number;
  /** Busy calendar time on a usual day like this weekday. */
  usualEventMinutes: number;
  level: 'light' | 'moderate' | 'full' | 'over';
}

export interface CalendarEvent {
  id: string;
  title: string | null;
  allDay: boolean;
  start: string;
  end: string;
  /** All-day events: the first date, and the day after the last. */
  startDate: string | null;
  endDate: string | null;
  busy: boolean;
  calendar: string;
  color: string | null;
}

/** Settings, Calendars: this phone's calendars, or how many busy days the person's phone shared. */
export interface Calendars {
  /** This phone reads its calendars. */
  on: boolean;
  calendars: { id: string; account: string | null; name: string; color: string | null; primary: boolean; counts: boolean }[];
  /** Days from today on that the person's phone shared as busy. */
  sharedDays: number;
}

export interface Suggestion {
  task: Task;
  reason: string;
  why: 'overdue' | 'due' | 'must' | 'waiting';
  fits: boolean;
}

export interface Briefing {
  date: string;
  seen: boolean;
  greeting: string;
  load: DayLoad;
  events: CalendarEvent[];
  handedOver: { task: Task; from: string; note: string | null }[];
  carriedOver: Task[];
  suggestions: Suggestion[];
}

export interface DayPick {
  task: Task;
  date: string;
  weekday: string;
  fits: boolean;
  reason: string;
}

export interface Gap {
  date: string;
  weekday: string;
  fits: boolean;
  reason: string;
  estimateMinutes: number;
}

export interface PlannedWeek {
  start: string;
  days: DayLoad[];
  picks: DayPick[];
  note: string | null;
  by: 'ai' | 'planner';
}

export type OrganizeSuggestion =
  | { kind: 'regroup'; taskId: string; title: string; groupId: string; groupName: string; reason: string }
  | { kind: 'merge'; taskIds: string[]; titles: string[]; title: string; reason: string }
  | { kind: 'split'; taskId: string; title: string; into: string[]; reason: string };

export interface Today {
  today: string;
  planned: Task[];
  carriedOver: Task[];
  due: Task[];
  done: Task[];
  load: DayLoad;
}

export interface HouseholdMember {
  id: string;
  name: string;
  email: string;
  color: string;
  avatarUrl: string | null;
  role: 'admin' | 'member';
  signedIn: boolean;
}

export interface ListItem {
  id: string;
  groupId: string;
  name: string;
  quantity: string | null;
  note: string | null;
  section: string | null;
  url: string | null;
  price: string | null;
  store: string | null;
  /** A meal's ingredients. */
  parts: string[] | null;
  checkedAt: string | null;
}

export interface AiStatus {
  available: boolean;
  /** Available and switched on for this person. */
  smartAdd: boolean;
  provider: AiProviderId | null;
  providerName: string | null;
  model: string | null;
  modelName: string | null;
  effort: AiEffort | null;
  /** Set up in the app, in the server's environment, or the household's server's model, which this device asks. */
  source: 'settings' | 'environment' | 'server' | null;
  /** The server's environment sets a model too. */
  environment: boolean;
  /** Spending is counted, so the cap applies. */
  priced: boolean;
  monthSpendUsd: number;
  monthlyCapUsd: number;
  /** For the admin: what's set, without the key. */
  settings: {
    provider: AiProviderId;
    model: string;
    baseUrl: string;
    effort: AiEffort;
    monthlyCapUsd: number;
    prices: [number, number] | null;
    keyEnding: string | null;
  } | null;
  keyUnreadable: boolean;
  /** On a device syncing with the household's server: the server's model, used unless this device has its own. */
  server: { providerName: string; modelName: string } | null;
}

/** The household's server's own settings, for Settings, Your server (server/settings.ts). */
export interface ServerSettings {
  url: string;
  /** Who this device is signed in to the server as. */
  me: { name: string; email: string; role: string };
  mcpUrl: string;
  /** Claude or ChatGPT, connected as this person. */
  connections: { id: string; clientName: string; createdAt: string; lastUsedAt: string | null }[];
  /** The household's model, kept on the server. */
  ai: AiStatus;
  /** Bringing a household over from Google Drive; for an admin, when the server can. */
  drive: { account: string | null; on: boolean; name: string | null; syncedAt: string | null; error: string | null } | null;
}

export type SmartAddResponse =
  | { proposals: Proposal[]; unclear: string | null; usage: { inputTokens: number; outputTokens: number; ms: number } }
  | { fallback: string };

export interface CapacityDay {
  weekday: number;
  minutes: number;
  samples: number;
  confidence: number;
  default: number;
  pinned: number | null;
}

export interface ActivityEntry {
  id: string;
  at: string;
  memberId: string | null;
  memberName: string | null;
  /** `assistant` is one connected through the connector that Amble can't name. */
  via: 'app' | 'claude' | 'chatgpt' | 'assistant' | 'system';
  action: string;
  taskId: string | null;
  taskTitle: string | null;
  detail: Record<string, unknown> | null;
  /** Repeated edits to one task fold into one entry. */
  count: number;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  next: string | null;
}

export type TimeOfDayBucket = 'morning' | 'afternoon' | 'evening' | 'night';

export interface Stats {
  today: string;
  weekStart: number;
  members: { id: string; name: string; color: string; avatarUrl: string | null }[];
  weeks: { start: string; total: number; byMember: Record<string, number> }[];
  weekdays: { day: number; count: number }[];
  timesOfDay: { key: TimeOfDayBucket; count: number }[];
  pilingUp: { groupId: string | null; name: string; icon: string; color: string; open: number; oldestDays: number; added: number; done: number }[];
  estimates: {
    made: number;
    kept: number;
    raised: number;
    lowered: number;
    typicalRatio: number | null;
    months: { month: string; made: number; kept: number }[];
  };
  records: {
    streak: { current: number; best: number };
    bestWeek: { start: string; count: number } | null;
    oldestDone: { taskId: string; title: string; days: number } | null;
    totalDone: number;
    since: string | null;
  } | null;
}

export interface ListHistoryItem {
  name: string;
  quantity: string | null;
  section: string | null;
  /** On the list right now, rather than checked off before. */
  onList: boolean;
}

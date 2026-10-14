import type { ThemePrefs } from './theme.ts';

declare global {
  interface Window {
    __ALMANAC__?: { basePath: string };
  }
}

export const basePath = window.__ALMANAC__?.basePath ?? '';

export const appUrl = (path: string) => `${basePath}${path}`;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(appUrl(`/api${path}`), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
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
}

export interface Session {
  member: Member | null;
  auth: { provider: string; oidc: boolean; devEmails: string[] };
}

export interface Group {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: 'tasks' | 'list';
  template: string | null;
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
  assigneeId: string | null;
  assigneeName: string | null;
  createdById: string | null;
  createdByName: string | null;
  dueDate: string | null;
  plannedDate: string | null;
  timeOfDay: TimeOfDay | null;
  mustDo: boolean;
  estimateMinutes: number | null;
  status: 'open' | 'done' | 'archived';
  completedAt: string | null;
  handedBackNote: string | null;
  createdAt: string;
  subtasks: { id: string; title: string; done: boolean }[];
  links: { id: string; url: string; title: string | null }[];
}

export interface DayLoad {
  date: string;
  weekday: string;
  tasks: number;
  mustDo: number;
  plannedMinutes: number;
  guessed: number;
  capacityMinutes: number;
  level: 'light' | 'moderate' | 'full' | 'over';
}

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
  checkedAt: string | null;
}

export async function signOut() {
  await fetch(appUrl('/auth/logout'), { method: 'POST' });
  window.location.assign(appUrl('/'));
}

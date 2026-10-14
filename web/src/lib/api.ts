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
}

export async function signOut() {
  await fetch(appUrl('/auth/logout'), { method: 'POST' });
  window.location.assign(appUrl('/'));
}

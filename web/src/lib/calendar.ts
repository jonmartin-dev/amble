// Calendars sync on the server every ten minutes; opening the app (or coming back to it) asks for a
// sync too, so a meeting added a minute ago already shapes the day.
import type { QueryClient } from '@tanstack/react-query';
import { api } from './api.ts';

const AT_MOST_EVERY_MS = 2 * 60 * 1000;
const DAY_VIEWS = ['load', 'events', 'today', 'briefing', 'gaps', 'calendars'];

let last = 0;

async function syncNow(qc: QueryClient) {
  if (!navigator.onLine || Date.now() - last < AT_MOST_EVERY_MS) return;
  last = Date.now();
  try {
    const { synced } = await api<{ synced: number }>('/calendars/sync', { method: 'POST', body: '{}' });
    if (synced) for (const key of DAY_VIEWS) void qc.invalidateQueries({ queryKey: [key] });
  } catch {
    // Offline or signed out: the server's own schedule keeps calendars fresh anyway.
  }
}

/** Syncs now and whenever the app comes back to the front. Returns a cleanup. */
export function syncCalendarsWhileOpen(qc: QueryClient) {
  void syncNow(qc);
  const onVisible = () => document.visibilityState === 'visible' && void syncNow(qc);
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}

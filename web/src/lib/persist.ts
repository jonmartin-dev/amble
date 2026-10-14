// Keeps what the app last loaded on the device, so Today, the backlog, task pages and lists open
// without a connection. The copy belongs to whoever is signed in and goes when they sign out.
import type { Query, QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { appUrl, type Group } from './api.ts';
import { kvDel, kvGet, kvSet } from './idb.ts';
import { discardQueue, syncState } from './sync.ts';

const CACHE_KEY = 'query-cache';
const OWNER_KEY = 'owner';
const WRITE_EVERY_MS = 1000;

/** Bump when a saved response's shape changes, so an old copy isn't read as a new one. */
export const CACHE_VERSION = '1';
/**
 * How long a saved copy stays usable after the app last ran. Queries stay in memory as long, so it
 * must stay under setTimeout's limit (about 24.8 days): past that the timer fires at once and every
 * restored query is dropped before anything can show it.
 */
export const CACHE_MAX_AGE_MS = 20 * 24 * 60 * 60 * 1000;

// Views that only make sense live, or that hold things not worth keeping.
const LIVE_ONLY = new Set(['connections', 'oauth', 'smart-add']);

export function shouldSave(query: Query) {
  const [kind, params] = query.queryKey as [string, unknown];
  // Searches come and go with each keystroke; they aren't worth keeping.
  const search = kind === 'tasks' && typeof params === 'object' && params != null && 'q' in params;
  return query.state.status === 'success' && !LIVE_ONLY.has(kind) && !search;
}

/** Saves the query cache to IndexedDB at most once a second, and right away when the app is hidden. */
export function idbPersister(): Persister {
  let latest: PersistedClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    if (latest) void kvSet(CACHE_KEY, latest).catch(() => {});
    latest = null;
  };
  // Phones freeze or kill a backgrounded app without warning; this is the last safe moment.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && write());
  window.addEventListener('pagehide', write);
  return {
    persistClient(client) {
      latest = client;
      timer ??= setTimeout(write, WRITE_EVERY_MS);
    },
    restoreClient: () => kvGet<PersistedClient>(CACHE_KEY).catch(() => undefined),
    removeClient: () => kvDel(CACHE_KEY).catch(() => {}),
  };
}

/**
 * Called with each signed-in member. If the saved copy and waiting changes were someone else's
 * (they signed out without this app knowing), they're dropped.
 */
export async function claimDevice(qc: QueryClient, memberId: string) {
  const owner = await kvGet<string>(OWNER_KEY).catch(() => undefined);
  if (owner === memberId) return;
  if (owner) {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
    await Promise.all([kvDel(CACHE_KEY), discardQueue()]).catch(() => {});
  }
  await kvSet(OWNER_KEY, memberId).catch(() => {});
}

/** Loads what should work offline even if nobody has opened it yet: every list and the whole backlog. */
export function prefetchForOffline(qc: QueryClient, get: <T>(path: string) => Promise<T>) {
  void qc.prefetchQuery({ queryKey: ['tasks', {}], queryFn: () => get('/tasks') });
  void qc.prefetchQuery({ queryKey: ['members'], queryFn: () => get('/members') });
  void qc.fetchQuery({ queryKey: ['groups'], queryFn: () => get<{ groups: Group[] }>('/groups') }).then(({ groups }) => {
    for (const g of groups.filter((g) => g.kind === 'list')) {
      void qc.prefetchQuery({ queryKey: ['list', g.id], queryFn: () => get(`/lists/${g.id}`) });
    }
  });
}

/** Signs out, dropping this device's copy and anything still waiting to sync (after asking). */
export async function signOut(qc?: QueryClient) {
  const waiting = syncState().pending;
  if (waiting && !confirm(`${waiting} ${waiting === 1 ? "change hasn't" : "changes haven't"} synced yet. Sign out anyway and lose ${waiting === 1 ? 'it' : 'them'}?`)) {
    return;
  }
  await Promise.all([discardQueue(), kvDel(CACHE_KEY), kvDel(OWNER_KEY)]).catch(() => {});
  qc?.clear();
  await fetch(appUrl('/auth/logout'), { method: 'POST' }).catch(() => {});
  window.location.assign(appUrl('/'));
}

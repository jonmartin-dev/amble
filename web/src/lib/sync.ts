// The app's side of the outbox: queues changes, sends them whenever there's a connection, and
// tells the screen how it's going. The screen updates the moment a change is made (see local.ts),
// so nothing here makes anyone wait.
import { useSyncExternalStore } from 'react';
import { basePath } from './api.ts';
import { addOp, clearOps, countOps, flush, takeFailures, type Blocked, type Failure, type Op } from './outbox.ts';

export interface SyncState {
  /** Changes made here that the server hasn't confirmed yet. */
  pending: number;
  /** Sending right now. */
  syncing: boolean;
  /** Why changes are still waiting, if they are. */
  blocked: Blocked | null;
  online: boolean;
}

export interface SyncHandlers {
  /** Changes reached the server: refresh what's on screen from it. */
  onSent(): void;
  /** The server turned changes down; they've been dropped. */
  onFailed(failures: Failure[]): void;
  onSignedOut(): void;
}

let state: SyncState = { pending: 0, syncing: false, blocked: null, online: navigator.onLine };
const listeners = new Set<() => void>();
let handlers: SyncHandlers | null = null;
let running: Promise<void> | null = null;
let again = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 2000;
let idleWaiters: (() => void)[] = [];

function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
  if (state.pending === 0 && !running) {
    for (const w of idleWaiters) w();
    idleWaiters = [];
  }
}

export function useSyncState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const syncState = () => state;

/**
 * Resolves once every waiting change has reached the server, or after `ms`. Reads wait for this,
 * so a refresh never shows the server's copy from before a change that's still on its way.
 */
export function syncIdle(ms = 4000): Promise<void> {
  if (state.pending === 0 && !running) return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
    setTimeout(resolve, ms);
  });
}

/** Adds a change to the outbox and starts sending. Resolves once it's stored on this device. */
export async function queue(op: Omit<Op, 'key' | 'at' | 'seq'>) {
  set({ pending: state.pending + 1 });
  await addOp({ ...op, key: crypto.randomUUID(), at: Date.now() });
  kick();
}

/** Drops every waiting change, for signing out. */
export async function discardQueue() {
  await clearOps();
  set({ pending: 0, blocked: null });
}

async function reportFailures() {
  const failures = await takeFailures().catch(() => []);
  if (failures.length) handlers?.onFailed(failures);
}

function backgroundSync() {
  // Chrome on Android sends the outbox from the service worker once the connection is back, even
  // if the app has been closed by then.
  void navigator.serviceWorker?.ready
    .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register('almanac-outbox'))
    .catch(() => {});
}

function retryLater(delay: number) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(kick, delay);
}

/** Sends whatever is waiting, unless a send is already running (which then goes round again). */
export function kick() {
  if (running) {
    again = true;
    return;
  }
  clearTimeout(retryTimer);
  running = (async () => {
    let sentAny = false;
    do {
      again = false;
      const waiting = await countOps().catch(() => 0);
      if (waiting === 0) {
        set({ pending: 0, blocked: null });
        break;
      }
      set({ pending: waiting, syncing: true });
      const result = await flush(basePath).catch(() => ({ sent: [], failed: [], blocked: 'offline' as const }));
      const pending = await countOps().catch(() => 0);
      sentAny ||= result.sent.length > 0;
      set({ pending, syncing: false, blocked: pending ? result.blocked : null, ...(result.sent.length && { online: true }) });
      if (result.failed.length) await reportFailures();
      if (result.blocked === 'signed-out') handlers?.onSignedOut();
      else if (result.blocked === 'busy') retryLater(1500);
      else if (result.blocked) {
        // Offline: the browser says when it's back. Online but failing: try again, backing off.
        backgroundSync();
        if (navigator.onLine) retryLater(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      }
      if (result.blocked) break;
      retryDelay = 2000;
    } while (again);
    if (sentAny) handlers?.onSent();
  })().finally(() => {
    running = null;
    set({});
  });
}

/** Starts sending the outbox for this app session: now, when the connection returns, and on return to the app. */
export function startSync(h: SyncHandlers) {
  const first = handlers == null;
  handlers = h;
  if (!first) return;
  window.addEventListener('online', () => {
    set({ online: true });
    retryDelay = 2000;
    kick();
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if ((e.data as { type?: string } | null)?.type !== 'outbox-flushed') return;
    void reportFailures();
    void countOps().then((pending) => set({ pending, blocked: pending ? state.blocked : null }));
    handlers?.onSent();
  });
  void reportFailures();
  kick();
}

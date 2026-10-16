// Changes made in the app, written straight into Amble's database on this device (its worker), one
// after another in the order they were made. The screen shows each change the moment it's made
// (local.ts), and a write takes milliseconds, so nothing waits on a connection; syncing with Drive
// or the household's server happens after, from the database (drive-sync.ts). The one thing kept
// for later is a reminder's Done or Snooze tapped while no Amble window was open: the service
// worker leaves it in a small mailbox (outbox.ts), which Amble applies when it next opens.
import { useSyncExternalStore } from 'react';
import { send } from './api.ts';
import { clearOps, countOps, flush, takeFailures, type Failure } from './outbox.ts';

export interface SyncState {
  /** Changes made here and not written yet: only ever a moment. */
  pending: number;
  /** Writing right now. */
  syncing: boolean;
  /** For what needs the internet, like smart add. */
  online: boolean;
}

export interface SyncHandlers {
  /** Changes were written: refresh what's on screen, and pass them on. */
  onSent(): void;
  /** A change was turned down (it no longer made sense, like editing a task someone removed). */
  onFailed(failures: Failure[]): void;
}

let state: SyncState = { pending: 0, syncing: false, online: navigator.onLine };
const listeners = new Set<() => void>();
let handlers: SyncHandlers | null = null;
let idleWaiters: (() => void)[] = [];
// Each write starts after the one before it, so they land in the order they were made.
let chain: Promise<void> = Promise.resolve();
let wrote = false;
// Turned down before the app was listening.
let early: Failure[] = [];

function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
  if (state.pending === 0) {
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

/** Resolves once every change made so far is written, or after `ms`. Reads wait for this, so they never miss one. */
export function syncIdle(ms = 4000): Promise<void> {
  if (state.pending === 0) return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
    setTimeout(resolve, ms);
  });
}

function failed(failures: Failure[]) {
  if (handlers) handlers.onFailed(failures);
  else early.push(...failures);
}

/** Writes a change to this device's database, after any made before it. Resolves once it's written (or turned down). */
export function queue(op: { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown; label: string }): Promise<void> {
  set({ pending: state.pending + 1 });
  const run = chain.then(async () => {
    set({ syncing: true });
    try {
      const res = await send(op.path, {
        method: op.method,
        headers: { 'Content-Type': 'application/json' },
        body: op.body === undefined ? undefined : JSON.stringify(op.body),
      });
      if (res.ok) wrote = true;
      else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        failed([{ label: op.label, message: body?.error ?? `It didn't save (${res.status}).`, at: Date.now() }]);
      }
    } catch {
      failed([{ label: op.label, message: 'Amble on this device didn’t answer. Try again.', at: Date.now() }]);
    } finally {
      const pending = state.pending - 1;
      set({ pending, syncing: pending > 0 });
      if (pending === 0 && wrote) {
        wrote = false;
        handlers?.onSent();
      }
    }
  });
  chain = run.catch(() => {});
  return run;
}

/** Empties the reminder mailbox, for a device someone else takes over. */
export async function discardQueue() {
  await clearOps();
}

/** Applies what the service worker left in the mailbox (outbox.ts) while no Amble window was open. */
async function openMailbox() {
  if (!(await countOps().catch(() => 0))) return;
  const result = await flush(send).catch(() => null);
  const failures = await takeFailures().catch(() => []);
  if (failures.length) failed(failures);
  if (result?.sent.length) handlers?.onSent();
}

/** Starts listening for this app session: written changes, the reminder mailbox, and the connection. */
export function startSync(h: SyncHandlers) {
  const first = handlers == null;
  handlers = h;
  if (early.length) {
    h.onFailed(early);
    early = [];
  }
  if (!first) return;
  window.addEventListener('online', () => set({ online: true }));
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void openMailbox();
  });
  // A reminder's Done or Snooze, left by the service worker while this window was open too.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if ((e.data as { type?: string } | null)?.type === 'outbox-added') void openMailbox();
  });
  void openMailbox();
}

// Keeping this device in step with Google Drive while Almanac is open: a round when it opens, every
// minute while it's on screen, and soon after each change. The worker does the merging; this only
// brings it a Google token. When the token has run out, sync waits for a tap.
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { onDevice } from './device.ts';
import { forgetToken, googleConfigured, resumeAfterGoogle, syncToken } from './google.ts';
import { native } from './native.ts';

export interface DriveSyncStatus {
  on: boolean;
  target: { kind: 'personal' | 'household'; fileId: string; name: string; owner: string | null } | null;
  account: { email: string; name: string | null } | null;
  syncedAt: string | null;
  error: string | null;
  waiting: boolean;
}

export interface DriveSyncState {
  status: DriveSyncStatus | null;
  syncing: boolean;
  /** Google's token ran out; a tap brings it back. */
  needsGoogle: boolean;
}

const EVERY_MS = 60_000;
const AFTER_CHANGE_MS = 4000;
const SIGN_IN_AGAIN = 'Google needs you to sign in again.';

let state: DriveSyncState = { status: null, syncing: false, needsGoogle: false };
const listeners = new Set<() => void>();
let onMerged: (() => void) | null = null;
let soon: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;

function set(patch: Partial<DriveSyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useDriveSync() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const driveSyncState = () => state;

export async function refreshStatus() {
  const status = await api<DriveSyncStatus>('/sync');
  set({ status });
  return status;
}

/** One round, if sync is on and there's a token. With `tap`, it may open Google's sign-in. */
export function syncNow({ tap = false } = {}): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      const status = state.status ?? (await refreshStatus());
      if (!status.on) return;
      // The Android app can get a fresh token itself when Google turns one down, so it tries twice.
      for (let attempt = 0; attempt < (native ? 2 : 1); attempt++) {
        const token = await syncToken(tap, status.account?.email);
        if (!token) {
          set({ needsGoogle: true });
          return;
        }
        set({ syncing: true, needsGoogle: false });
        const result = await api<{ merged: number; uploaded: boolean; error: string | null }>('/sync/run', { method: 'POST', body: JSON.stringify({ token }) });
        if (result.merged > 0) onMerged?.();
        if (result.error !== SIGN_IN_AGAIN) break;
        forgetToken();
        set({ needsGoogle: !native || attempt > 0 });
      }
      await refreshStatus();
    } finally {
      set({ syncing: false });
      running = null;
    }
  })();
  return running;
}

/** After a change here, a round a few seconds later picks it up (several changes share one round). */
export function syncSoon() {
  if (!onDevice || !state.status?.on) return;
  clearTimeout(soon);
  soon = setTimeout(() => void syncNow().catch(() => {}), AFTER_CHANGE_MS);
}

/** Starts syncing for as long as the app is open. `merged` refreshes the screen after others' changes. */
export function startDriveSync(merged: () => void) {
  if (!onDevice || !googleConfigured) return () => {};
  onMerged = merged;
  // Back from Google after a tap on "Continue": the token is in hand now.
  resumeAfterGoogle('sync');
  void refreshStatus()
    .then((s) => (s.on ? syncNow() : undefined))
    .catch(() => {});
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow().catch(() => {});
  }, EVERY_MS);
  const onVisible = () => document.visibilityState === 'visible' && void syncNow().catch(() => {});
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

// Keeping this device in step with Google Drive, or the household's own server, while Amble is
// open: a round when it opens, every minute while it's on screen, and soon after each change. The
// worker does the merging; for Drive this only brings it a Google token. When a browser's token runs out and can't be refreshed in place, it
// renews with a quick trip to Google at a moment nobody's using the page (google.ts), and asks for a
// tap only if that trip needed the person.
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { canRenewQuietly, forgetToken, googleConfigured, renewQuietly, resumeAfterGoogle, syncToken } from './google.ts';
import { native } from './native.ts';

export interface DriveSyncStatus {
  on: boolean;
  target: { kind: 'personal' | 'household' | 'server'; fileId: string; name: string; owner: string | null; url?: string } | null;
  account: { email: string; name: string | null } | null;
  syncedAt: string | null;
  error: string | null;
  waiting: boolean;
  /** The household's own server, when this device syncs through Drive and the household has one. */
  householdServer: string | null;
  /** The invite to it the household file carries, so moving there takes a tap. */
  householdJoin: string | null;
  /** Moved here from Drive: the Drive file this device keeps in step for whoever hasn't moved yet. */
  bridge: { name: string; account: string | null; syncedAt: string | null; error: string | null } | null;
}

export interface DriveSyncState {
  status: DriveSyncStatus | null;
  syncing: boolean;
  /** Google wants the person: a tap brings sync back. */
  needsGoogle: boolean;
}

const EVERY_MS = 60_000;
const AFTER_CHANGE_MS = 4000;
// How long the page sits untouched before a renewal that reloads it is fine.
const IDLE_MS = 2 * 60_000;
const SIGN_IN_AGAIN = 'Google needs you to sign in again.';

let state: DriveSyncState = { status: null, syncing: false, needsGoogle: false };
const listeners = new Set<() => void>();
let onMerged: (() => void) | null = null;
let soon: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
// The first round after Amble opens, when a reload costs nothing.
let opening = true;
let touchedAt = Date.now();

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

/**
 * Whether reloading the page now would cost nobody anything: Amble just opened, the tab is hidden
 * with changes to send, or the page has sat untouched with nothing open or being typed in.
 */
function quietMoment(status: DriveSyncStatus) {
  if (opening) return true;
  if (document.visibilityState === 'hidden') return status.waiting;
  if (Date.now() - touchedAt < IDLE_MS) return false;
  const typing = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
  return !typing && !document.querySelector('[role="dialog"], dialog[open]');
}

/** One round, if sync is on and there's a token. With `tap`, it may open Google's sign-in. */
export function syncNow({ tap = false } = {}): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      const status = state.status ?? (await refreshStatus());
      if (!status.on) return;
      // A server needs no Google token: the device keeps its own sign-in there. One that moved from
      // Drive brings the Drive file along for the others while a token comes without asking.
      if (status.target?.kind === 'server') {
        set({ syncing: true, needsGoogle: false });
        const token = status.bridge ? await syncToken(false, status.bridge.account ?? undefined).catch(() => null) : null;
        const result = await api<{ merged: number }>('/sync/run', { method: 'POST', body: JSON.stringify(token ? { token } : {}) });
        if (result.merged > 0) onMerged?.();
        await refreshStatus();
        return;
      }
      // The Android app can get a fresh token itself when Google turns one down, so it tries twice.
      for (let attempt = 0; attempt < (native ? 2 : 1); attempt++) {
        const token = await syncToken(tap, status.account?.email);
        if (!token) {
          const email = status.account?.email;
          const quietly = !native && Boolean(email) && canRenewQuietly();
          if (quietly && quietMoment(status)) await renewQuietly(email!);
          // Otherwise it waits for a quieter moment, or, if Google wants the person, for a tap.
          set({ needsGoogle: !quietly });
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
      opening = false;
      set({ syncing: false });
      running = null;
    }
  })();
  return running;
}

/** After a change here, a round a few seconds later picks it up (several changes share one round). */
export function syncSoon() {
  if (!state.status?.on) return;
  clearTimeout(soon);
  soon = setTimeout(() => void syncNow().catch(() => {}), AFTER_CHANGE_MS);
}

/** Starts syncing for as long as the app is open. `merged` refreshes the screen after others' changes. */
export function startDriveSync(merged: () => void) {
  onMerged = merged;
  // Back from Google after a tap on "Continue": the token is in hand now.
  if (googleConfigured) resumeAfterGoogle('sync');
  void refreshStatus()
    .then((s) => {
      if (s.on) return syncNow();
      opening = false;
    })
    .catch(() => {});
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow().catch(() => {});
  }, EVERY_MS);
  // Coming back gets a round; so does leaving, to send what changed before the tab is put away.
  const onVisible = () => void syncNow().catch(() => {});
  const touched = () => (touchedAt = Date.now());
  document.addEventListener('visibilitychange', onVisible);
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, touched, { passive: true, capture: true });
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(type, touched, { capture: true });
  };
}

// Notifications on this device, for reminders: whether they can be on here, and turning them on
// and off. The app shows reminders itself; in the Android app, the phone does, even with Amble
// closed. Amble only ever notifies someone about a reminder they set.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { kvDel, kvGet, kvSet } from './idb.ts';
import { askPhoneNotifyPermission, cancelPhoneReminders, checkInBackground, native, phoneNotifyPermission, schedulePhoneReminders } from './native.ts';

/**
 * - unsupported: this browser can't show notifications from a web app.
 * - needs-install: iPhone and iPad can, once Amble is added to the home screen.
 * - blocked: the person said no in the browser; only its site settings can undo that.
 */
export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on';

const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export const pushSupported = () => native || 'Notification' in window;

/** The address that stands for "this browser" once reminders are on here. */
const DEVICE_ENDPOINT = 'device-endpoint';
async function deviceEndpoint() {
  return kvGet<string>(DEVICE_ENDPOINT).catch(() => undefined);
}

/** This device's sign-up for reminders, if notifications are on here. */
export async function currentSubscription(): Promise<{ endpoint: string; unsubscribe(): Promise<unknown> } | null> {
  if (!pushSupported()) return null;
  const endpoint = await deviceEndpoint();
  return endpoint ? { endpoint, unsubscribe: () => kvDel(DEVICE_ENDPOINT) } : null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isApple() && !installed() ? 'needs-install' : 'unsupported';
  if (native) {
    const permission = await phoneNotifyPermission();
    if (permission === 'denied') return 'blocked';
    return permission === 'granted' && (await currentSubscription()) ? 'on' : 'off';
  }
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' && (await currentSubscription()) ? 'on' : 'off';
}

/** Asks for permission (call it from a tap) and signs this device up for reminders. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = native ? await askPhoneNotifyPermission() : await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const endpoint = (await deviceEndpoint()) ?? `device:${crypto.randomUUID()}`;
  await api('/push/subscriptions', { method: 'POST', body: JSON.stringify({ endpoint, keys: { p256dh: '-', auth: '-' } }) });
  await kvSet(DEVICE_ENDPOINT, endpoint);
  if (native) await syncPhoneReminders();
  return 'on';
}

/** Stops reminders on this device. */
export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe();
  if (native) await cancelPhoneReminders();
}

/**
 * In the Android app, with reminders on here: hands the phone the coming ones again, after a
 * change, and keeps it checking in the background for ones set elsewhere.
 */
export async function syncPhoneReminders() {
  if (!native || !(await currentSubscription())) return;
  await schedulePhoneReminders();
  await checkInBackground();
}

/** This device's notification state, checked again whenever the app comes back to the front. */
export function usePushState() {
  const [state, setState] = useState<PushState | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const check = useCallback(async () => {
    setState(await pushState());
    setEndpoint((await currentSubscription())?.endpoint ?? null);
  }, []);
  useEffect(() => {
    void check();
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check]);
  return { state, endpoint, check };
}

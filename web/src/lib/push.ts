// Notifications on this device, for reminders: whether they can be on here, turning them on and
// off, and keeping the server's record of this device current. Almanac only ever notifies someone
// about a reminder they set.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { onDevice } from './device.ts';
import { kvDel, kvGet, kvSet } from './idb.ts';

/**
 * - unsupported: this browser can't show notifications from a web app.
 * - needs-install: iPhone and iPad can, once Almanac is added to the home screen.
 * - blocked: the person said no in the browser; only its site settings can undo that.
 */
export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on';

const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

// On a device with no server, the app shows reminders itself, so only notifications are needed.
export const pushSupported = () => (onDevice ? 'Notification' in window : 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);

/** On a device, the address that stands for "this browser" once reminders are on here. */
const DEVICE_ENDPOINT = 'device-endpoint';
async function deviceEndpoint() {
  return kvGet<string>(DEVICE_ENDPOINT).catch(() => undefined);
}

function keyBytes(base64url: string) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Whether a subscription was made with the server's current key. */
function sameKey(sub: PushSubscription, publicKey: string) {
  const had = sub.options.applicationServerKey;
  if (!had) return false;
  const a = new Uint8Array(had);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const registration = () => navigator.serviceWorker.getRegistration();

/** This device's subscription, if notifications are on here. */
export async function currentSubscription(): Promise<{ endpoint: string; unsubscribe(): Promise<unknown> } | null> {
  if (!pushSupported()) return null;
  if (onDevice) {
    const endpoint = await deviceEndpoint();
    return endpoint ? { endpoint, unsubscribe: () => kvDel(DEVICE_ENDPOINT) } : null;
  }
  return (await (await registration())?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isApple() && !installed() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' && (await currentSubscription()) ? 'on' : 'off';
}

async function subscribe(reg: ServiceWorkerRegistration, publicKey: string) {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/push/subscriptions', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
}

/** Asks the browser for permission (call it from a tap) and signs this device up for reminders. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  if (onDevice) {
    const endpoint = (await deviceEndpoint()) ?? `device:${crypto.randomUUID()}`;
    await api('/push/subscriptions', { method: 'POST', body: JSON.stringify({ endpoint, keys: { p256dh: '-', auth: '-' } }) });
    await kvSet(DEVICE_ENDPOINT, endpoint);
    return 'on';
  }
  const reg = await registration();
  if (!reg) throw new Error("Notifications need the installed app. Reload Almanac and try again.");
  const { publicKey } = await api<{ publicKey: string }>('/push');
  await subscribe(reg, publicKey);
  return 'on';
}

/** Stops reminders on this device. */
export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe();
}

/**
 * On start: sends this device's subscription to the server again, so reminders follow whoever is
 * signed in here and a new server key doesn't leave the device silently signed up with the old one.
 */
export async function refreshPush() {
  if (onDevice || !pushSupported() || Notification.permission !== 'granted') return;
  const reg = await registration();
  if (!reg || !(await reg.pushManager.getSubscription())) return;
  const { publicKey } = await api<{ publicKey: string }>('/push');
  await subscribe(reg, publicKey);
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

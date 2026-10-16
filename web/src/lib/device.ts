// Amble runs on the device: its API runs in a worker here (web/src/worker/api.worker.ts), and the
// app's requests go to it. Only one tab can have the database open; another tab waits, and can
// take it over.
import { Capacitor } from '@capacitor/core';
import { useSyncExternalStore } from 'react';
import type { FromWorker, ToWorker } from '../worker/protocol.ts';

declare global {
  interface Window {
    /** Written into the page by an Amble server that serves the app (server/app.ts). */
    __AMBLE__?: {
      basePath: string;
      server?: { url: string; signIn: string; privacyContact: string; ai: { provider: string; name: string } | null };
      google?: { clientId: string; apiKey: string; appId: string; tokenUrl: string } | null;
      /** Set by a server with dev sign-in on, for scripts that drive the app (scripts/lib/household.ts). */
      test?: boolean;
    };
    /** The device's API, for those scripts. */
    __ambleFetch?: typeof deviceFetch;
  }
}

/** The path the app is served under: from the server that serves it, or the one it was built for. */
export const basePath = window.__AMBLE__?.basePath ?? (import.meta.env.BASE_URL === './' ? '' : import.meta.env.BASE_URL.replace(/\/$/, ''));

export type DeviceState = 'starting' | 'ready' | 'busy' | 'moved' | 'failed';

let state: DeviceState = 'starting';
let failure = '';
const listeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (res: Response) => void; reject: (err: unknown) => void }>();
let readyNow: () => void;
let ready = new Promise<void>((resolve) => (readyNow = resolve));
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('almanac-device');

function set(next: DeviceState) {
  state = next;
  for (const l of listeners) l();
}

export function useDeviceState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const deviceFailure = () => failure;

/** Called when the worker changed something on its own, like a size guess. */
export function onDeviceChange(fn: () => void) {
  changeListeners.add(fn);
  return () => void changeListeners.delete(fn);
}

const send = (message: ToWorker, transfer: Transferable[] = []) => worker!.postMessage(message, transfer);

async function showNotification(message: Extract<FromWorker, { type: 'notify' }>['message']) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const options = {
    body: message.body,
    tag: message.tag,
    icon: new URL('icon-192.png', document.baseURI).href,
    badge: new URL('badge-96.png', document.baseURI).href,
    actions: message.actions ?? [],
    data: { url: message.url, ...message.data },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(message.title, options);
    else new Notification(message.title, options);
    return true;
  } catch {
    return false;
  }
}

function startWorker() {
  worker = new Worker(new URL('../worker/api.worker.ts', import.meta.url), { type: 'module', name: 'amble' });
  worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
    const m = event.data;
    if (m.type === 'ready') {
      set('ready');
      readyNow();
    } else if (m.type === 'busy') set('busy');
    else if (m.type === 'failed') {
      failure = m.message;
      set('failed');
    } else if (m.type === 'response') {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      w?.resolve(new Response(m.body, { status: m.status, headers: m.headers }));
    } else if (m.type === 'notify') {
      // In the Android app the phone shows reminders, mostly ahead of the app noticing them.
      const shown = Capacitor.isNativePlatform() ? import('./native.ts').then((n) => n.showOnPhone(m.message)) : showNotification(m.message);
      void shown.catch(() => false).then((ok) => send({ type: 'notified', id: m.id, ok }));
    } else if (m.type === 'changed') for (const l of changeListeners) l();
  });
  worker.addEventListener('error', (e) => {
    failure = e.message || 'The worker stopped.';
    set('failed');
  });
  send({ type: 'init', basePath, userAgent: navigator.userAgent });
}

/** Another tab wants the database: let it go. */
function release() {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new DOMException('Amble moved to another tab.', 'AbortError'));
  waiting.clear();
  ready = new Promise<void>((resolve) => (readyNow = resolve));
  set('moved');
}

/** Takes the database back from whichever tab has it. */
export function useHere() {
  channel?.postMessage({ type: 'takeover' });
  if (!worker) {
    set('starting');
    startWorker();
  }
}

channel?.addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
  if (e.data?.type === 'takeover' && worker && state !== 'busy') release();
});

// Not in tests, which have no workers.
if (typeof Worker !== 'undefined') {
  startWorker();
  // Asks the browser not to clear Amble's storage to make room; installed apps usually get this.
  void navigator.storage?.persist?.().catch(() => {});
}
if (window.__AMBLE__?.test) window.__ambleFetch = deviceFetch;

/** fetch() for the device's own API: `path` is under /api. */
export async function deviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await ready;
  const headers: [string, string][] = [...new Headers(init.headers)];
  const body = init.body;
  let payload: string | Blob | ArrayBuffer | null = null;
  if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer) payload = body;
  else if (body instanceof Uint8Array) payload = body.slice().buffer;
  else if (body != null) payload = await new Response(body).arrayBuffer();
  const id = ++nextId;
  return new Promise<Response>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    init.signal?.addEventListener('abort', () => {
      waiting.delete(id);
      reject(new DOMException('Aborted', 'AbortError'));
    });
    send({ type: 'request', id, method: init.method ?? 'GET', path, headers, body: payload });
  });
}

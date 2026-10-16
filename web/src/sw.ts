// Amble's service worker, built by the `serviceWorker` plugin in vite.config.ts.
// - Keeps every file of this build so the app opens without a connection. A new build installs in
//   the background and waits; the app offers a reload rather than swapping code under someone.
// - Handles the Done and Snooze buttons on the reminders the app shows.
import { addOp } from './lib/outbox.ts';

declare const __AMBLE_BUILD__: string;
declare const __AMBLE_ASSETS__: string[];

// The DOM typings don't describe a service worker's scope; these are the parts used here.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface MessageEventLike extends ExtendableEvent {
  data: unknown;
}
interface NotificationClickEvent extends ExtendableEvent {
  notification: Notification;
  action: string;
}
interface WindowClient {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface ServiceWorkerScope {
  registration: ServiceWorkerRegistration;
  clients: {
    claim(): Promise<void>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (e: MessageEventLike) => void): void;
  addEventListener(type: 'notificationclick', listener: (e: NotificationClickEvent) => void): void;
}

/** A reminder as the app shows it (server/notify/devices.ts). */
interface PushMessage {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
  actions?: { action: string; title: string }[];
  data?: { kind?: string; reminderId?: string; taskId?: string; memberId?: string; snoozeMinutes?: number };
}

const sw = globalThis as unknown as ServiceWorkerScope;
const CACHE = `almanac-${__AMBLE_BUILD__}`;
const scope = new URL(sw.registration.scope);
const base = scope.pathname.replace(/\/$/, '');
const shell = new URL('./', scope).href;
// Paths an Amble server serving the app answers itself, never the app shell.
const SERVER_PATHS = ['/api/', '/auth/', '/oauth/', '/sync/', '/server', '/google/', '/mcp', '/.well-known/', '/healthz'];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // The first version that keeps files replaces the old placeholder worker straight away;
      // later versions wait for the app to say the person chose to reload.
      const first = !(await caches.keys()).some((k) => k.startsWith('almanac-'));
      const cache = await caches.open(CACHE);
      // The page itself comes from the server, which writes the base path into it.
      await cache.addAll([shell, ...__AMBLE_ASSETS__.map((a) => new URL(a, scope).href)]);
      if (first) await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('almanac-') && key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'skip-waiting') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(base)) return;
  const path = url.pathname.slice(base.length) || '/';
  if (SERVER_PATHS.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return;

  if (request.mode === 'navigate') {
    // Every screen is the same page; the app routes from the address.
    event.respondWith(caches.match(shell).then((hit) => hit ?? fetch(request)));
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then(async (res) => {
          // Font subsets for other scripts load only when needed; keep them once they have.
          if (res.ok && path.startsWith('/assets/')) await (await caches.open(CACHE)).put(request, res.clone());
          return res;
        }),
    ),
  );
});

// ---- reminders ------------------------------------------------------------------------------

/** Brings the app forward on a page, opening it if it isn't open. */
async function openApp(url: string | undefined) {
  const target = new URL(url ?? shell, scope.origin);
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((w) => w.url.startsWith(shell));
  if (open) {
    // The app routes itself, so it keeps its state rather than loading again. Told first, so a
    // browser that won't bring the window forward still lands it on the task.
    open.postMessage({ type: 'open', path: target.pathname.slice(base.length) || '/' });
    await open.focus().catch(() => {});
    return;
  }
  await sw.clients.openWindow(target.href);
}

/**
 * Done and Snooze go through the outbox: the app's own worker applies them, from an open window
 * now, or the next one opened.
 */
async function act(action: 'done' | 'snooze', title: string, data: NonNullable<PushMessage['data']>) {
  if (!data.memberId || !data.taskId) return;
  const op =
    action === 'done'
      ? { path: `/tasks/${data.taskId}/complete`, body: { done: true }, label: `Finish ${title}` }
      : { path: `/reminders/${data.reminderId}/snooze`, body: { minutes: data.snoozeMinutes ?? 60 }, label: `Snooze ${title}` };
  await addOp({ ...op, method: 'POST', memberId: data.memberId, key: crypto.randomUUID(), at: Date.now() });
  for (const client of await sw.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'outbox-added' });
}

sw.addEventListener('notificationclick', (event) => {
  const { notification, action } = event;
  const data = (notification.data ?? {}) as NonNullable<PushMessage['data']> & { url?: string };
  notification.close();
  if (action === 'done' || action === 'snooze') event.waitUntil(act(action, notification.title, data));
  else event.waitUntil(openApp(data.url));
});

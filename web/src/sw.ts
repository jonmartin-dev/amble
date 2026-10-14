// Almanac's service worker, built by the `serviceWorker` plugin in vite.config.ts.
// - Keeps every file of this build so the app opens without a connection. A new build installs in
//   the background and waits; the app offers a reload rather than swapping code under someone.
// - Sends changes made offline once the connection is back, even with the app closed (Background
//   Sync, where the browser has it).
import { flush } from './lib/outbox.ts';

declare const __ALMANAC_BUILD__: string;
declare const __ALMANAC_ASSETS__: string[];

// The DOM typings don't describe a service worker's scope; these are the parts used here.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface SyncEvent extends ExtendableEvent {
  tag: string;
}
interface MessageEventLike extends ExtendableEvent {
  data: unknown;
}
interface ServiceWorkerScope {
  registration: ServiceWorkerRegistration;
  clients: { claim(): Promise<void>; matchAll(options?: { type?: string }): Promise<{ postMessage(message: unknown): void }[]> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (e: FetchEvent) => void): void;
  addEventListener(type: 'sync', listener: (e: SyncEvent) => void): void;
  addEventListener(type: 'message', listener: (e: MessageEventLike) => void): void;
}

const sw = globalThis as unknown as ServiceWorkerScope;
const CACHE = `almanac-${__ALMANAC_BUILD__}`;
const scope = new URL(sw.registration.scope);
const base = scope.pathname.replace(/\/$/, '');
const shell = new URL('./', scope).href;
// Paths the server answers itself, never the app shell.
const SERVER_PATHS = ['/api/', '/auth/', '/oauth/', '/mcp', '/.well-known/', '/healthz'];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // The first version that keeps files replaces the old placeholder worker straight away;
      // later versions wait for the app to say the person chose to reload.
      const first = !(await caches.keys()).some((k) => k.startsWith('almanac-'));
      const cache = await caches.open(CACHE);
      // The page itself comes from the server, which writes the base path into it.
      await cache.addAll([shell, ...__ALMANAC_ASSETS__.map((a) => new URL(a, scope).href)]);
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

sw.addEventListener('sync', (event) => {
  if (event.tag !== 'almanac-outbox') return;
  event.waitUntil(
    flush(base).then(async (result) => {
      for (const client of await sw.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'outbox-flushed' });
      // Rejecting asks the browser to try again later.
      if (result.blocked === 'offline' || result.blocked === 'server' || result.blocked === 'busy') throw new Error(result.blocked);
    }),
  );
});

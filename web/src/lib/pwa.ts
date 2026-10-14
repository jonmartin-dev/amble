// Registers the service worker and notices when a new version has been deployed. The new one
// installs in the background and waits; the app offers a reload instead of running stale code.
import { useSyncExternalStore } from 'react';
import { appUrl, basePath } from './api.ts';

const CHECK_EVERY_MS = 30 * 60 * 1000;
const CHECK_ON_RETURN_AFTER_MS = 60 * 1000;

let waiting: ServiceWorker | null = null;
let reloading = false;
const listeners = new Set<() => void>();

function setWaiting(worker: ServiceWorker | null) {
  waiting = worker;
  for (const l of listeners) l();
}

/** True once a new version is downloaded and waiting for a reload. */
export function useUpdateReady() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => waiting != null,
  );
}

/** Switches to the waiting version and reloads into it. Changes still waiting to sync are kept on the device. */
export function applyUpdate() {
  if (!waiting) return;
  reloading = true;
  waiting.postMessage({ type: 'skip-waiting' });
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) window.location.reload();
  });
  void navigator.serviceWorker.register(appUrl('/sw.js'), { scope: `${basePath}/` }).then((reg) => {
    // Only an update waits behind a running version; the very first install just takes over.
    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const settle = () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker);
        if ((worker.state === 'activated' || worker.state === 'redundant') && waiting === worker && !reloading) setWaiting(null);
      };
      settle();
      worker.addEventListener('statechange', settle);
    };
    watch(reg.waiting ?? reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));

    let checked = Date.now();
    const check = () => {
      checked = Date.now();
      void reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - checked > CHECK_ON_RETURN_AFTER_MS) check();
    });
    setInterval(() => document.visibilityState === 'visible' && check(), CHECK_EVERY_MS);
  });
}

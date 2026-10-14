// Almanac service worker. It makes the app installable now; push notifications
// and offline caching land in later phases.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

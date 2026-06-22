/* IBI Group Messenger — Service Worker
 * Minimal SW: enables PWA installability + offline shell caching.
 * Network-first for all requests so live chat data is never stale.
 */
const CACHE  = 'ibi-group-messenger-v6.3';
const SHELL  = ['./'];          // cache the app shell only

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Remove old cache versions
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always pass GAS requests straight to network (live data)
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleapis.com')    ||
      url.hostname.includes('googleusercontent.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first for everything else; fall back to cache for offline shell
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache same-origin GET responses
        if (e.request.method === 'GET' && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

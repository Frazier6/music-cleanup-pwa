// service-worker.js — MusicCleanup PWA
const CACHE   = 'music-cleanup-v8-3.1';
const VERSION = '3.1';
const ASSETS  = [
  './',
  './index.html',
  './worker.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&display=swap'
];

// ── Install: cache all assets immediately ────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches, claim clients ───────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all clients the new version is active
        return self.clients.matchAll({ type: 'window' }).then(clients =>
          clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION, cache: CACHE }))
        );
      })
  );
});

// ── Fetch: cache-first, revalidate in background ─────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    // Navigation: network-first with cache fallback
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
  } else {
    // Assets: cache-first, refresh in background
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => {});
        return cached || fresh;
      })
    );
  }
});

// ── Message handler: skipWaiting on demand ───────────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* SunSizer ZA service worker — network-first for same-origin, cache as
   offline fallback. Cache-first for JS let a stale engine.js pair with a
   fresh index.html after an update (stale-shell bug, saw it as a wrong
   payback figure). The shell is tiny; always fetching it is cheap. */
const CACHE = 'ssza-v0.9.9';
const SHELL = ['./', './index.html', './engine.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // open-meteo + wa.me: network only
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    }).catch(() => e.request.mode === 'navigate'
      ? caches.match('./index.html')
      : caches.match(e.request))
  );
});

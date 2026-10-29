/* ============================================================
   GRANDPRIDE EMPLOYEE — service worker (network-first)
   Lives in /employee/ so its scope is /employee/ only and it
   can NEVER replace the Hub's sw.js (scope ./ of the repo root).
   Bump CACHE on each deploy (same number as APP_BUILD).
   ============================================================ */
const CACHE = 'gp-employee-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', '../icon-192.png', '../icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('gp-employee-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // never cache live data: Supabase, ImgBB, maps/geocode, Apps Script
  if (/grandlab\.com\.my|supabase\.co|imgbb\.com|ibb\.co|nominatim\.openstreetmap\.org|script\.google\.com/.test(url.host)) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && (url.origin === location.origin || /jsdelivr|unpkg|fonts\.(googleapis|gstatic)/.test(url.host))) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
  );
});

/* ---- push notifications (same push-send Edge Function as the Hub) ---- */
self.addEventListener('push', e => {
  let data = { title: 'Grandpride Employee', body: '' };
  try { data = e.data.json(); } catch (_) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title || 'Grandpride Employee', {
    body: data.body || '', icon: '../icon-192.png', badge: '../icon-192.png', data: { url: './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.indexOf('/employee/') >= 0 && 'focus' in c) return c.focus(); }
    return clients.openWindow('./');
  }));
});

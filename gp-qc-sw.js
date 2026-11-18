/* ============================================================
   GP QC — service worker (network-first)
   ------------------------------------------------------------
   Same strategy as the hub: always try the network so a deploy
   reaches the driver immediately. The cache is only a fallback
   for when the phone has no signal — which matters here, because
   drivers do QC in basement car parks.

   Bump CACHE on every deploy.
   ============================================================ */
const CACHE = 'gp-qc-v1';

self.addEventListener('install', e => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never touch the RPC posts or uploads
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never intercept Supabase or WhatsApp

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit =>
          hit || (req.mode === 'navigate' ? caches.match('./gp-qc.html') : undefined))
      )
  );
});

/* GrandPride Chauffeur — standalone service worker (separate from the Hub sw.js) */
const CACHE = 'gp-chauffeur-v1';
const CORE = [
  'gp-chauffeur.html',
  'gp-chauffeur.webmanifest',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('gp-chauffeur-') && k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // never cache Supabase API / storage / ImgBB / geocode — always live
  if (/supabase\.co|api\.imgbb\.com|nominatim\.openstreetmap\.org|script\.google\.com/.test(url.host)) return;
  // network-first for the app shell so updates come through; fall back to cache offline
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req))
  );
});
